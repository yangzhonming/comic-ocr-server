#include <jni.h>
#include <android/log.h>
#include <android/asset_manager_jni.h>
#include <android/bitmap.h>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <chrono>
#include <sstream>
#include <iomanip>

#include <gpu.h>
#include "DBNetDetector.h"
#include "CRNNRecognizer.h"
#include "BubbleClustering.h"

#define TAG "ComicOcrJni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static DBNetDetector* g_detector = nullptr;
static CRNNRecognizer* g_recognizer = nullptr;

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
    delete g_detector;
    delete g_recognizer;
    g_detector = nullptr;
    g_recognizer = nullptr;
#if NCNN_VULKAN
    ncnn::destroy_gpu_instance();
#endif
}

JNIEXPORT jboolean JNICALL
Java_com_comic_ocr_OcrNative_nativeInit(JNIEnv* env, jobject thiz, jobject asset_manager) {
    AAssetManager* mgr = AAssetManager_fromJava(env, asset_manager);
    if (!mgr) {
        LOGE("Failed to get AAssetManager");
        return JNI_FALSE;
    }

    if (!g_detector) g_detector = new DBNetDetector();
    if (!g_recognizer) g_recognizer = new CRNNRecognizer();

    // 1. Init DBNet
    bool det_ok = g_detector->initFromAssets(mgr, "models/ch_PP-OCRv4_det.param", "models/ch_PP-OCRv4_det.bin", true);
    if (!det_ok) {
        LOGE("Failed to init DBNet detector");
        return JNI_FALSE;
    }

    // 2. Init CRNN models
    g_recognizer->initModelFromAssets(mgr, "korean", "models/korean_PP-OCRv5_rec.param", "models/korean_PP-OCRv5_rec.bin", "dicts/ppocrv5_korean_dict.txt", true);
    g_recognizer->initModelFromAssets(mgr, "en", "models/en_PP-OCRv5_rec.param", "models/en_PP-OCRv5_rec.bin", "dicts/ppocrv5_en_dict.txt", true);
    g_recognizer->initModelFromAssets(mgr, "japan", "models/japan_PP-OCRv4_rec.param", "models/japan_PP-OCRv4_rec.bin", "dicts/japan_dict.txt", true);
    g_recognizer->initModelFromAssets(mgr, "cyrillic", "models/cyrillic_PP-OCRv5_rec.param", "models/cyrillic_PP-OCRv5_rec.bin", "dicts/ppocrv5_cyrillic_dict.txt", true);

    LOGI("All native OCR models initialized successfully!");
    return JNI_TRUE;
}

JNIEXPORT jstring JNICALL
Java_com_comic_ocr_OcrNative_nativeProcessSlice(
    JNIEnv* env,
    jobject thiz,
    jobject bitmap,
    jstring lang_str,
    jint start_y,
    jint slice_index
) {
    auto t_start = std::chrono::high_resolution_clock::now();

    if (!g_detector || !g_recognizer) {
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

    // 2. DET Detection
    std::vector<TextBox> boxes = g_detector->detect(image, 1024, 0.30f, 0.55f, 1.60f);

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

    // 5. REC Recognition
    std::vector<RecResult> rec_results = g_recognizer->recognizeBatch(crops, lang);

    // 6. Clean and filter
    std::vector<TextLine> text_lines;
    for (size_t i = 0; i < rec_results.size(); ++i) {
        const auto& rec = rec_results[i];
        if (rec.text.empty()) continue;

        // Threshold check: 0.70 min rec score
        if (rec.score < 0.70f) continue;
        if (det_scores[i] < 0.70f && rec.score < 0.75f) continue;
        if (BubbleClustering::isNoiseOrWatermark(rec.text)) continue;

        TextLine tl;
        tl.bbox = valid_box_rects[i];
        tl.text = rec.text;
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
