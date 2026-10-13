#include <jni.h>
#include <android/log.h>
#include <android/asset_manager_jni.h>
#include <android/bitmap.h>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <chrono>
#include <sstream>
#include <iomanip>
#include <mutex>

#include <gpu.h>
#include "DBNetDetector.h"
#include "CRNNRecognizer.h"
#include "BubbleClustering.h"

#define TAG "ComicOcrJni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static DBNetDetector* g_detector = nullptr;
static CRNNRecognizer* g_recognizer = nullptr;
static AAssetManager* g_asset_mgr = nullptr;
static std::mutex g_ocr_mutex;
static std::mutex g_init_mutex;
static bool g_initialized = false;

static std::string escapeJsonString(const std::string& input) {
    std::ostringstream ss;
    for (char c : input) {
        switch (c) {
            case '"':  ss << "\\\""; break;
            case '\\': ss << "\\\\"; break;
            case '\b': ss << "\\b";  break;
            case '\f': ss << "\\f";  break;
            case '\n': ss << "\\n";  break;
            case '\r': ss << "\\r";  break;
            case '\t': ss << "\\t";  break;
            default:
                if ('\x00' <= c && c <= '\x1f') {
                    ss << "\\u" << std::hex << std::setw(4) << std::setfill('0') << static_cast<int>(c);
                } else {
                    ss << c;
                }
        }
    }
    return ss.str();
}

extern "C" {

JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved) {
    LOGI("JNI_OnLoad: initializing GPU instance");
#if NCNN_VULKAN
    ncnn::create_gpu_instance();
#endif
    return JNI_VERSION_1_6;
}

JNIEXPORT void JNI_OnUnload(JavaVM* vm, void* reserved) {
    LOGI("JNI_OnUnload: destroying GPU instance");
    std::lock_guard<std::mutex> lock(g_ocr_mutex);
    delete g_detector;
    delete g_recognizer;
    g_detector = nullptr;
    g_recognizer = nullptr;
    g_asset_mgr = nullptr;
    g_initialized = false;
#if NCNN_VULKAN
    ncnn::destroy_gpu_instance();
#endif
}

JNIEXPORT jboolean JNICALL
Java_com_comic_ocr_OcrNative_nativeInit(JNIEnv* env, jobject thiz, jobject asset_manager) {
    std::lock_guard<std::mutex> lock(g_init_mutex);
    if (g_initialized && g_detector && g_recognizer) {
        LOGI("Native OCR models already initialized");
        return JNI_TRUE;
    }

    AAssetManager* mgr = AAssetManager_fromJava(env, asset_manager);
    if (!mgr) {
        LOGE("Failed to get AAssetManager");
        return JNI_FALSE;
    }
    g_asset_mgr = mgr;

    if (!g_detector) g_detector = new DBNetDetector();
    if (!g_recognizer) g_recognizer = new CRNNRecognizer();

    // 1. Init DBNet Detector
    bool det_ok = g_detector->initFromAssets(mgr, "models/ch_PP-OCRv4_det.param", "models/ch_PP-OCRv4_det.bin", true);
    if (!det_ok) {
        LOGE("Failed to init DBNet detector");
        return JNI_FALSE;
    }

    // 2. Init Core CRNN models: Prioritize Korean & English (instant startup)
    g_recognizer->initModelFromAssets(mgr, "korean", "models/korean_PP-OCRv5_rec.param", "models/korean_PP-OCRv5_rec.bin", "dicts/ppocrv5_korean_dict.txt", true);
    g_recognizer->initModelFromAssets(mgr, "en", "models/en_PP-OCRv5_rec.param", "models/en_PP-OCRv5_rec.bin", "dicts/ppocrv5_en_dict.txt", true);

    g_initialized = true;
    LOGI("Core native OCR models (Det + Korean + English) initialized successfully!");
    return JNI_TRUE;
}

JNIEXPORT jstring JNICALL
Java_com_comic_ocr_OcrNative_nativeProcessSlice(
    JNIEnv* env,
    jobject thiz,
    jobject bitmap,
    jstring lang_str,
    jint start_y,
    jint slice_index,
    jfloat rec_thresh,
    jfloat box_thresh
) {
    std::lock_guard<std::mutex> lock(g_ocr_mutex);
    auto t_start = std::chrono::high_resolution_clock::now();

    if (!g_detector || !g_recognizer || !g_initialized) {
        return env->NewStringUTF("{\"code\":500,\"message\":\"OCR Engine not initialized\"}");
    }

    // 1. Get Bitmap buffer and convert to cv::Mat BGR
    AndroidBitmapInfo info;
    if (AndroidBitmap_getInfo(env, bitmap, &info) < 0) {
        return env->NewStringUTF("{\"code\":400,\"message\":\"Failed to get bitmap info\"}");
    }

    void* pixels = nullptr;
    if (AndroidBitmap_lockPixels(env, bitmap, &pixels) < 0 || !pixels) {
        return env->NewStringUTF("{\"code\":400,\"message\":\"Failed to lock bitmap pixels\"}");
    }

    cv::Mat image;
    if (info.format == ANDROID_BITMAP_FORMAT_RGBA_8888) {
        cv::Mat rgba(info.height, info.width, CV_8UC4, pixels);
        cv::cvtColor(rgba, image, cv::COLOR_RGBA2BGR);
    } else if (info.format == ANDROID_BITMAP_FORMAT_RGB_565) {
        cv::Mat rgb565(info.height, info.width, CV_8UC2, pixels);
        cv::cvtColor(rgb565, image, cv::COLOR_BGR5652BGR);
    } else {
        AndroidBitmap_unlockPixels(env, bitmap);
        return env->NewStringUTF("{\"code\":400,\"message\":\"Unsupported bitmap format\"}");
    }
    AndroidBitmap_unlockPixels(env, bitmap);

    int orig_h = image.rows;
    int orig_w = image.cols;

    // Get language
    const char* lang_cstr = env->GetStringUTFChars(lang_str, nullptr);
    std::string lang = lang_cstr ? lang_cstr : "korean";
    if (lang_cstr) env->ReleaseStringUTFChars(lang_str, lang_cstr);

    // On-demand lazy loading for secondary languages
    if (g_recognizer && g_asset_mgr && !g_recognizer->hasLang(lang)) {
        if (lang == "japan" || lang == "ja" || lang == "jp" || lang == "japanese") {
            LOGI("Lazy loading Japanese OCR model on demand...");
            g_recognizer->initModelFromAssets(g_asset_mgr, "japan", "models/japan_PP-OCRv4_rec.param", "models/japan_PP-OCRv4_rec.bin", "dicts/japan_dict.txt", true);
        } else if (lang == "cyrillic" || lang == "ru" || lang == "russian") {
            LOGI("Lazy loading Cyrillic OCR model on demand...");
            g_recognizer->initModelFromAssets(g_asset_mgr, "cyrillic", "models/cyrillic_PP-OCRv5_rec.param", "models/cyrillic_PP-OCRv5_rec.bin", "dicts/ppocrv5_cyrillic_dict.txt", true);
        }
    }

    float b_thresh = (box_thresh > 0.05f) ? box_thresh : 0.55f;
    float r_thresh = (rec_thresh > 0.05f) ? rec_thresh : 0.70f;

    // 2. DET Detection
    std::vector<TextBox> boxes = g_detector->detect(image, 1024, 0.30f, b_thresh, 1.60f);

    // 3. Korean horizontal merge
    bool is_korean = (lang == "korean" || lang == "kr" || lang == "ko");
    if (is_korean) {
        boxes = BubbleClustering::mergeHorizontalBoxes(boxes, 0.50f, 1.5f, 1.8f);
    }

    // 4. Crop text boxes with +2px padding
    std::vector<cv::Mat> crops;
    std::vector<cv::Rect> valid_box_rects;
    std::vector<float> det_scores;
    const int pad = 2;

    for (const auto& box : boxes) {
        int x1 = std::max(0, box.bbox.x - pad);
        int y1 = std::max(0, box.bbox.y - pad);
        int x2 = std::min(orig_w, box.bbox.x + box.bbox.width + pad);
        int y2 = std::min(orig_h, box.bbox.y + box.bbox.height + pad);

        int bw = x2 - x1;
        int bh = y2 - y1;
        if (bw >= 4 && bh >= 4) {
            crops.push_back(image(cv::Rect(x1, y1, bw, bh)));
            valid_box_rects.push_back(cv::Rect(x1, y1, bw, bh));
            det_scores.push_back(box.score);
        }
    }

    if (crops.empty()) {
        auto t_end = std::chrono::high_resolution_clock::now();
        double cost_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();
        std::ostringstream json;
        json << std::fixed << std::setprecision(2);
        json << "{\"code\":0,\"message\":\"success\",\"slice_index\":" << slice_index
             << ",\"start_y\":" << start_y
             << ",\"cost_ms\":" << cost_ms
             << ",\"bubbles\":[]}";
        return env->NewStringUTF(json.str().c_str());
    }

    // 5. REC Recognition
    std::vector<RecResult> rec_results = g_recognizer->recognizeBatch(crops, lang);

    // 6. Clean and filter (对齐云端后过滤逻辑)
    std::vector<TextLine> text_lines;
    for (size_t i = 0; i < rec_results.size(); ++i) {
        const auto& rec = rec_results[i];
        std::string clean_text = BubbleClustering::trim(rec.text);
        if (clean_text.empty()) continue;

        // 1. 标点保护下的动态 REC 阈值 (无标点 +0.08，收紧至最高 0.82)
        bool has_dialogue_punct = BubbleClustering::hasDialoguePunct(clean_text);
        float target_min_rec = has_dialogue_punct ? r_thresh : std::min(r_thresh + 0.08f, 0.82f);
        if (rec.score < target_min_rec) continue;

        // 2. 双低联合截杀 (防背景网点误检)
        float det_floor = std::max(0.40f, b_thresh);
        float rec_floor = std::max(0.45f, r_thresh - 0.05f);
        if (det_scores[i] < det_floor && rec.score < rec_floor) continue;

        // 3. 强力过滤汉化组水印、扫图横幅与极短单字符噪音
        if (BubbleClustering::isNoiseOrWatermark(clean_text)) continue;

        TextLine tl;
        tl.bbox = valid_box_rects[i];
        tl.text = clean_text;
        tl.rec_score = rec.score;
        tl.det_score = det_scores[i];
        text_lines.push_back(tl);
    }

    // 7. Cluster and style bubbles
    std::vector<BubbleItem> bubbles = BubbleClustering::clusterAndStyle(text_lines, image, start_y, lang);

    auto t_end = std::chrono::high_resolution_clock::now();
    double cost_ms = std::chrono::duration<double, std::milli>(t_end - t_start).count();

    // 8. Serialize JSON
    std::ostringstream json;
    json << std::fixed << std::setprecision(2);
    json << "{\"code\":0,\"message\":\"success\",\"slice_index\":" << slice_index
         << ",\"start_y\":" << start_y
         << ",\"cost_ms\":" << cost_ms
         << ",\"bubbles\":[";

    for (size_t i = 0; i < bubbles.size(); ++i) {
        const auto& b = bubbles[i];
        if (i > 0) json << ",";
        json << "{"
             << "\"box_abs\":[" << b.box_abs[0] << "," << b.box_abs[1] << "," << b.box_abs[2] << "," << b.box_abs[3] << "],"
             << "\"box_rel\":[" << b.box_rel[0] << "," << b.box_rel[1] << "," << b.box_rel[2] << "," << b.box_rel[3] << "],"
             << "\"text\":\"" << escapeJsonString(b.text) << "\","
             << "\"bg\":\"" << b.bg << "\","
             << "\"fg\":\"" << b.fg << "\","
             << "\"size\":" << b.size << ","
             << "\"weight\":" << b.weight << ","
             << "\"score\":" << std::setprecision(3) << b.score << ","
             << "\"role\":\"" << b.role << "\","
             << "\"is_ghost\":" << (b.is_ghost ? "true" : "false") << ","
             << "\"surface\":\"" << b.surface << "\","
             << "\"render_mode\":\"" << b.render_mode << "\""
             << "}";
    }
    json << "]}";

    return env->NewStringUTF(json.str().c_str());
}

} // extern "C"
