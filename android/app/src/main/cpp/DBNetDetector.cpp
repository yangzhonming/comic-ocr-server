#include "DBNetDetector.h"
#include "clipper.h"

#include <opencv2/imgproc.hpp>
#include <algorithm>
#include <cmath>
#include <android/log.h>

#define TAG "DBNetDetector"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

DBNetDetector::DBNetDetector() {}

DBNetDetector::~DBNetDetector() {
    net_.clear();
}

bool DBNetDetector::init(const std::string& param_path, const std::string& bin_path, bool use_vulkan) {
#if NCNN_VULKAN
    has_vulkan_ = use_vulkan && (ncnn::get_gpu_count() > 0);
    net_.opt.use_vulkan_compute = has_vulkan_;
#endif
    net_.opt.num_threads = 4;
    net_.opt.use_fp16_packed = true;
    net_.opt.use_fp16_storage = true;
    net_.opt.use_fp16_arithmetic = true;

    int ret_param = net_.load_param(param_path.c_str());
    int ret_bin = net_.load_model(bin_path.c_str());
    if (ret_param != 0 || ret_bin != 0) {
        LOGE("Failed to load DBNet model: param=%d, bin=%d", ret_param, ret_bin);
        return false;
    }
    LOGI("DBNet loaded successfully (vulkan=%d)", has_vulkan_);
    return true;
}

bool DBNetDetector::initFromAssets(AAssetManager* mgr, const std::string& param_name, const std::string& bin_name, bool use_vulkan) {
#if NCNN_VULKAN
    has_vulkan_ = use_vulkan && (ncnn::get_gpu_count() > 0);
    net_.opt.use_vulkan_compute = has_vulkan_;
#endif
    net_.opt.num_threads = 4;
    net_.opt.use_fp16_packed = true;
    net_.opt.use_fp16_storage = true;
    net_.opt.use_fp16_arithmetic = true;

    int ret_param = net_.load_param(mgr, param_name.c_str());
    int ret_bin = net_.load_model(mgr, bin_name.c_str());
    if (ret_param != 0 || ret_bin != 0) {
        LOGE("Failed to load DBNet from assets: %s, %s", param_name.c_str(), bin_name.c_str());
        return false;
    }
    LOGI("DBNet loaded from assets successfully (vulkan=%d)", has_vulkan_);
    return true;
}

float DBNetDetector::getBoxScore(const cv::Mat& pred_map, const std::vector<cv::Point>& contour) {
    int h = pred_map.rows;
    int w = pred_map.cols;

    int xmin = w - 1, xmax = 0, ymin = h - 1, ymax = 0;
    for (const auto& pt : contour) {
        xmin = std::min(xmin, pt.x);
        xmax = std::max(xmax, pt.x);
        ymin = std::min(ymin, pt.y);
        ymax = std::max(ymax, pt.y);
    }
    xmin = std::max(0, std::min(w - 1, xmin));
    xmax = std::max(0, std::min(w - 1, xmax));
    ymin = std::max(0, std::min(h - 1, ymin));
    ymax = std::max(0, std::min(h - 1, ymax));

    int bw = xmax - xmin + 1;
    int bh = ymax - ymin + 1;
    if (bw <= 0 || bh <= 0) return 0.0f;

    cv::Mat mask = cv::Mat::zeros(bh, bw, CV_8UC1);
    std::vector<cv::Point> shifted_contour(contour.size());
    for (size_t i = 0; i < contour.size(); ++i) {
        shifted_contour[i] = cv::Point(contour[i].x - xmin, contour[i].y - ymin);
    }
    std::vector<std::vector<cv::Point>> contours_wrap = {shifted_contour};
    cv::fillPoly(mask, contours_wrap, cv::Scalar(1));

    cv::Mat sub_map = pred_map(cv::Rect(xmin, ymin, bw, bh));
    cv::Scalar mean_val = cv::mean(sub_map, mask);
    return static_cast<float>(mean_val[0]);
}

std::vector<cv::Point2f> DBNetDetector::orderPointsClockwise(const std::vector<cv::Point2f>& pts) {
    std::vector<cv::Point2f> rect(4);
    if (pts.size() != 4) return pts;

    // sum = x + y: top-left has min sum, bottom-right has max sum
    // diff = y - x: top-right has min diff, bottom-left has max diff
    std::vector<float> sum_vals(4);
    std::vector<float> diff_vals(4);
    for (int i = 0; i < 4; ++i) {
        sum_vals[i] = pts[i].x + pts[i].y;
        diff_vals[i] = pts[i].y - pts[i].x;
    }

    int tl_idx = static_cast<int>(std::min_element(sum_vals.begin(), sum_vals.end()) - sum_vals.begin());
    int br_idx = static_cast<int>(std::max_element(sum_vals.begin(), sum_vals.end()) - sum_vals.begin());
    int tr_idx = static_cast<int>(std::min_element(diff_vals.begin(), diff_vals.end()) - diff_vals.begin());
    int bl_idx = static_cast<int>(std::max_element(diff_vals.begin(), diff_vals.end()) - diff_vals.begin());

    rect[0] = pts[tl_idx];
    rect[1] = pts[tr_idx];
    rect[2] = pts[br_idx];
    rect[3] = pts[bl_idx];
    return rect;
}

std::vector<TextBox> DBNetDetector::suppressContainedBoxes(const std::vector<TextBox>& boxes, float containment_thresh) {
    if (boxes.size() <= 1) return boxes;

    std::vector<TextBox> sorted_boxes = boxes;
    std::sort(sorted_boxes.begin(), sorted_boxes.end(), [](const TextBox& a, const TextBox& b) {
        return (a.bbox.width * a.bbox.height) > (b.bbox.width * b.bbox.height);
    });

    std::vector<TextBox> kept;
    for (const auto& b : sorted_boxes) {
        float area_b = static_cast<float>(b.bbox.width * b.bbox.height);
        if (area_b <= 0.0f) continue;

        bool is_contained = false;
        for (const auto& k : kept) {
            float area_k = static_cast<float>(k.bbox.width * k.bbox.height);
            int ix1 = std::max(b.bbox.x, k.bbox.x);
            int iy1 = std::max(b.bbox.y, k.bbox.y);
            int ix2 = std::min(b.bbox.x + b.bbox.width, k.bbox.x + k.bbox.width);
            int iy2 = std::min(b.bbox.y + b.bbox.height, k.bbox.y + k.bbox.height);

            if (ix2 > ix1 && iy2 > iy1) {
                float inter_area = static_cast<float>((ix2 - ix1) * (iy2 - iy1));
                if ((inter_area / area_b) >= containment_thresh && area_k > area_b * 1.3f) {
                    is_contained = true;
                    break;
                }
            }
        }
        if (!is_contained) {
            kept.push_back(b);
        }
    }
    return kept;
}

std::vector<TextBox> DBNetDetector::detect(const cv::Mat& bgr_img, int limit_side_len, float thresh, float box_thresh, float unclip_ratio) {
    if (bgr_img.empty()) return {};

    int orig_h = bgr_img.rows;
    int orig_w = bgr_img.cols;

    // 1. Resize multiple of 32
    int max_side = std::max(orig_h, orig_w);
    float ratio = (max_side > limit_side_len) ? (static_cast<float>(limit_side_len) / max_side) : 1.0f;
    int rw = static_cast<int>(std::round(static_cast<float>(static_cast<int>(orig_w * ratio)) / 32.0f) * 32.0f);
    int rh = static_cast<int>(std::round(static_cast<float>(static_cast<int>(orig_h * ratio)) / 32.0f) * 32.0f);
    rw = std::max(32, rw);
    rh = std::max(32, rh);

    cv::Mat resized;
    cv::resize(bgr_img, resized, cv::Size(rw, rh));

    // 2. Prepare ncnn input
    ncnn::Mat in = ncnn::Mat::from_pixels(resized.data, ncnn::Mat::PIXEL_BGR2RGB, rw, rh);
    const float mean_vals[3] = {127.5f, 127.5f, 127.5f};
    const float norm_vals[3] = {1.0f / 127.5f, 1.0f / 127.5f, 1.0f / 127.5f};
    in.substract_mean_normalize(mean_vals, norm_vals);

    // 3. Inference
    ncnn::Extractor ex = net_.create_extractor();
    ex.input("in0", in);
    ncnn::Mat out;
    ex.extract("out0", out);

    // 4. Output probability map to cv::Mat
    cv::Mat pred_map(rh, rw, CV_32FC1, out.data);
    cv::Mat mask = (pred_map > thresh);

    // 5. Find contours
    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(mask, contours, cv::RETR_LIST, cv::CHAIN_APPROX_SIMPLE);

    float scale_x = static_cast<float>(orig_w) / rw;
    float scale_y = static_cast<float>(orig_h) / rh;

    std::vector<TextBox> raw_boxes;

    for (const auto& contour : contours) {
        if (contour.size() < 4) continue;

        float score = getBoxScore(pred_map, contour);
        if (score < box_thresh) continue;

        double area = cv::contourArea(contour);
        double length = cv::arcLength(contour, true);
        if (length <= 0.0) continue;

        double distance = area * unclip_ratio / length;

        // Unclip with Clipper
        ClipperLib::Path path;
        for (const auto& pt : contour) {
            path.push_back(ClipperLib::IntPoint(pt.x, pt.y));
        }

        ClipperLib::ClipperOffset offset;
        offset.AddPath(path, ClipperLib::jtRound, ClipperLib::etClosedPolygon);
        ClipperLib::Paths solution;
        offset.Execute(solution, distance);

        if (solution.empty()) continue;

        std::vector<cv::Point2f> poly_pts;
        for (const auto& ip : solution[0]) {
            poly_pts.push_back(cv::Point2f(static_cast<float>(ip.X), static_cast<float>(ip.Y)));
        }

        cv::RotatedRect min_rect = cv::minAreaRect(poly_pts);
        cv::Point2f rect_pts[4];
        min_rect.points(rect_pts);

        std::vector<cv::Point2f> pts_vec(rect_pts, rect_pts + 4);
        std::vector<cv::Point2f> ordered = orderPointsClockwise(pts_vec);

        // Scale to original coords
        float min_x = static_cast<float>(orig_w);
        float max_x = 0.0f;
        float min_y = static_cast<float>(orig_h);
        float max_y = 0.0f;

        for (int i = 0; i < 4; ++i) {
            ordered[i].x = std::max(0.0f, std::min(static_cast<float>(orig_w), ordered[i].x * scale_x));
            ordered[i].y = std::max(0.0f, std::min(static_cast<float>(orig_h), ordered[i].y * scale_y));
            min_x = std::min(min_x, ordered[i].x);
            max_x = std::max(max_x, ordered[i].x);
            min_y = std::min(min_y, ordered[i].y);
            max_y = std::max(max_y, ordered[i].y);
        }

        int bw = static_cast<int>(std::round(max_x - min_x));
        int bh = static_cast<int>(std::round(max_y - min_y));

        // Noise filter (bw < 8 && bh < 8) || (bw * bh < 60) || min(bw, bh) <= 3
        if ((bw < 8 && bh < 8) || (bw * bh < 60)) continue;
        if (std::min(bw, bh) <= 3) continue;

        TextBox box;
        box.points = ordered;
        box.bbox = cv::Rect(static_cast<int>(std::round(min_x)), static_cast<int>(std::round(min_y)), bw, bh);
        box.score = score;
        raw_boxes.push_back(box);
    }

    // 6. Nested box suppression
    return suppressContainedBoxes(raw_boxes, 0.75f);
}
