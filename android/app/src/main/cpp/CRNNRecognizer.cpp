#include "CRNNRecognizer.h"

#include <opencv2/imgproc.hpp>
#include <fstream>
#include <sstream>
#include <algorithm>
#include <cmath>
#include <android/log.h>
#include <android/asset_manager.h>

#define TAG "CRNNRecognizer"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

CRNNRecognizer::CRNNRecognizer() {}

CRNNRecognizer::~CRNNRecognizer() {
    engines_.clear();
}

std::string CRNNRecognizer::normalizeLang(const std::string& lang) const {
    std::string l = lang;
    std::transform(l.begin(), l.end(), l.begin(), ::tolower);
    if (l == "kr" || l == "ko" || l == "korean") return "korean";
    if (l == "en" || l == "english" || l == "es" || l == "spanish") return "en";
    if (l == "ja" || l == "jp" || l == "japan" || l == "japanese") return "japan";
    if (l == "ru" || l == "cyrillic" || l == "russian") return "cyrillic";
    return "korean"; // default
}

bool CRNNRecognizer::hasLang(const std::string& lang) const {
    return engines_.find(normalizeLang(lang)) != engines_.end();
}

bool CRNNRecognizer::initModel(const std::string& lang, const std::string& param_path, const std::string& bin_path, const std::string& dict_path, bool use_vulkan) {
    std::string norm_lang = normalizeLang(lang);
    auto engine = std::make_shared<LangEngine>();

#if NCNN_VULKAN
    engine->has_vulkan = use_vulkan && (ncnn::get_gpu_count() > 0);
    engine->net.opt.use_vulkan_compute = engine->has_vulkan;
#endif
    engine->net.opt.num_threads = 4;
    engine->net.opt.use_fp16_packed = true;
    engine->net.opt.use_fp16_storage = true;
    engine->net.opt.use_fp16_arithmetic = true;

    if (engine->net.load_param(param_path.c_str()) != 0 || engine->net.load_model(bin_path.c_str()) != 0) {
        LOGE("Failed to load REC model for %s", norm_lang.c_str());
        return false;
    }

    // Load dictionary
    std::ifstream f(dict_path);
    if (!f.is_open()) {
        LOGE("Failed to open dictionary file: %s", dict_path.c_str());
        return false;
    }
    std::vector<std::string> lines;
    lines.push_back("blank"); // index 0 is blank
    std::string line;
    while (std::getline(f, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        lines.push_back(line);
    }
    lines.push_back(" "); // space at the end
    engine->dictionary = lines;

    engines_[norm_lang] = engine;
    LOGI("REC model loaded for %s (dict size=%zu, vulkan=%d)", norm_lang.c_str(), lines.size(), engine->has_vulkan);
    return true;
}

bool CRNNRecognizer::initModelFromAssets(AAssetManager* mgr, const std::string& lang, const std::string& param_name, const std::string& bin_name, const std::string& dict_name, bool use_vulkan) {
    std::string norm_lang = normalizeLang(lang);
    auto engine = std::make_shared<LangEngine>();

#if NCNN_VULKAN
    engine->has_vulkan = use_vulkan && (ncnn::get_gpu_count() > 0);
    engine->net.opt.use_vulkan_compute = engine->has_vulkan;
#endif
    engine->net.opt.num_threads = 4;
    engine->net.opt.use_fp16_packed = true;
    engine->net.opt.use_fp16_storage = true;
    engine->net.opt.use_fp16_arithmetic = true;

    if (engine->net.load_param(mgr, param_name.c_str()) != 0 || engine->net.load_model(mgr, bin_name.c_str()) != 0) {
        LOGE("Failed to load REC from assets for %s", norm_lang.c_str());
        return false;
    }

    // Load dictionary from assets
    AAsset* asset = AAssetManager_open(mgr, dict_name.c_str(), AASSET_MODE_BUFFER);
    if (!asset) {
        LOGE("Failed to open dict asset: %s", dict_name.c_str());
        return false;
    }
    off_t size = AAsset_getLength(asset);
    std::string content(size, '\0');
    AAsset_read(asset, &content[0], size);
    AAsset_close(asset);

    std::vector<std::string> lines;
    lines.push_back("blank"); // index 0 is blank
    std::stringstream ss(content);
    std::string line;
    while (std::getline(ss, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        lines.push_back(line);
    }
    lines.push_back(" "); // space at end
    engine->dictionary = lines;

    engines_[norm_lang] = engine;
    LOGI("REC model loaded from assets for %s (dict size=%zu, vulkan=%d)", norm_lang.c_str(), lines.size(), engine->has_vulkan);
    return true;
}

RecResult CRNNRecognizer::decodeCTC(const ncnn::Mat& out, const std::vector<std::string>& dict) {
    RecResult result;
    int seq_len = out.h;
    int num_classes = out.w;

    if (seq_len <= 0 || num_classes <= 0) return result;

    int last_idx = 0;
    std::vector<float> confs;

    for (int t = 0; t < seq_len; ++t) {
        const float* row = out.row(t);
        int max_idx = 0;
        float max_prob = row[0];
        for (int c = 1; c < num_classes; ++c) {
            if (row[c] > max_prob) {
                max_prob = row[c];
                max_idx = c;
            }
        }

        if (max_idx != 0) {
            if (max_idx != last_idx) {
                if (max_idx < static_cast<int>(dict.size())) {
                    result.text += dict[max_idx];
                    confs.push_back(max_prob);
                }
            }
        }
        last_idx = max_idx;
    }

    if (!confs.empty()) {
        float sum = 0.0f;
        for (float c : confs) sum += c;
        result.score = sum / static_cast<float>(confs.size());
    }
    return result;
}

RecResult CRNNRecognizer::recognize(const cv::Mat& bgr_crop, const std::string& lang) {
    if (bgr_crop.empty()) return {};

    std::string norm_lang = normalizeLang(lang);
    auto it = engines_.find(norm_lang);
    if (it == engines_.end()) {
        it = engines_.find("korean");
        if (it == engines_.end()) return {};
    }
    auto& engine = it->second;

    int target_h = 48;
    int target_w = static_cast<int>(std::round(48.0f * static_cast<float>(bgr_crop.cols) / static_cast<float>(bgr_crop.rows)));
    target_w = std::max(16, target_w);

    cv::Mat resized;
    cv::resize(bgr_crop, resized, cv::Size(target_w, target_h));

    ncnn::Mat in = ncnn::Mat::from_pixels(resized.data, ncnn::Mat::PIXEL_BGR2RGB, target_w, target_h);
    const float mean_vals[3] = {127.5f, 127.5f, 127.5f};
    const float norm_vals[3] = {1.0f / 127.5f, 1.0f / 127.5f, 1.0f / 127.5f};
    in.substract_mean_normalize(mean_vals, norm_vals);

    ncnn::Extractor ex = engine->net.create_extractor();
    ex.input("in0", in);
    ncnn::Mat out;
    ex.extract("out0", out);

    return decodeCTC(out, engine->dictionary);
}

std::vector<RecResult> CRNNRecognizer::recognizeBatch(const std::vector<cv::Mat>& bgr_crops, const std::string& lang) {
    std::vector<RecResult> results;
    results.reserve(bgr_crops.size());
    for (const auto& crop : bgr_crops) {
        results.push_back(recognize(crop, lang));
    }
    return results;
}
