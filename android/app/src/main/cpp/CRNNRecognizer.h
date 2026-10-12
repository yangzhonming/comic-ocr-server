#pragma once

#include <vector>
#include <string>
#include <unordered_map>
#include <memory>
#include <opencv2/core.hpp>
#include <net.h>

struct RecResult {
    std::string text;
    float score = 0.0f;
};

class CRNNRecognizer {
public:
    CRNNRecognizer();
    ~CRNNRecognizer();

    bool initModel(const std::string& lang, const std::string& param_path, const std::string& bin_path, const std::string& dict_path, bool use_vulkan = true);
    bool initModelFromAssets(AAssetManager* mgr, const std::string& lang, const std::string& param_name, const std::string& bin_name, const std::string& dict_name, bool use_vulkan = true);

    RecResult recognize(const cv::Mat& bgr_crop, const std::string& lang = "korean");
    std::vector<RecResult> recognizeBatch(const std::vector<cv::Mat>& bgr_crops, const std::string& lang = "korean");

    bool hasLang(const std::string& lang) const;

private:
    struct LangEngine {
        ncnn::Net net;
        std::vector<std::string> dictionary;
        bool has_vulkan = false;
    };

    std::unordered_map<std::string, std::shared_ptr<LangEngine>> engines_;
    std::string normalizeLang(const std::string& lang) const;
    RecResult decodeCTC(const ncnn::Mat& out, const std::vector<std::string>& dict);
};
