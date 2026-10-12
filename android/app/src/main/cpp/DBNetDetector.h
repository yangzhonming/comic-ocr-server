#pragma once

#include <vector>
#include <string>
#include <memory>
#include <opencv2/core.hpp>
#include <net.h>

struct TextBox {
    std::vector<cv::Point2f> points; // 4 corner points in clockwise order
    cv::Rect bbox;                   // Axis-aligned bounding rect [x, y, w, h]
    float score = 0.0f;
};

class DBNetDetector {
public:
    DBNetDetector();
    ~DBNetDetector();

    bool init(const std::string& param_path, const std::string& bin_path, bool use_vulkan = true);
    bool initFromAssets(AAssetManager* mgr, const std::string& param_name, const std::string& bin_name, bool use_vulkan = true);

    std::vector<TextBox> detect(const cv::Mat& bgr_img, int limit_side_len = 1024, float thresh = 0.30f, float box_thresh = 0.55f, float unclip_ratio = 1.60f);

private:
    ncnn::Net net_;
    bool has_vulkan_ = false;

    float getBoxScore(const cv::Mat& pred_map, const std::vector<cv::Point>& contour);
    std::vector<cv::Point2f> orderPointsClockwise(const std::vector<cv::Point2f>& pts);
    std::vector<TextBox> suppressContainedBoxes(const std::vector<TextBox>& boxes, float containment_thresh = 0.75f);
};
