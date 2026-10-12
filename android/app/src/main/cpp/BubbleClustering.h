#pragma once

#include <vector>
#include <string>
#include <opencv2/core.hpp>
#include "DBNetDetector.h"
#include "CRNNRecognizer.h"

struct BubbleItem {
    std::vector<int> box_abs; // [x, y, w, h] in absolute global chapter coords
    std::vector<int> box_rel; // [x, y, w, h] in local slice coords
    std::string text;
    std::string bg = "#FFFFFF";
    std::string fg = "#000000";
    int size = 16;
    int weight = 400;
    float score = 1.0f;
    std::string role = "dialogue";
    bool is_ghost = false;
    std::string surface = "white_solid";
    std::string render_mode = "solid_patch";
};

struct TextLine {
    cv::Rect bbox;
    std::string text;
    float rec_score = 0.0f;
    float det_score = 0.0f;
    float fill_ratio = 0.35f;
};

struct PurityInfo {
    float top1_purity = 1.0f;
    float top3_purity = 1.0f;
    int num_colors = 1;
    float lum_std = 0.0f;
    bool is_messy = false;
};

class BubbleClustering {
public:
    static std::vector<TextBox> mergeHorizontalBoxes(
        const std::vector<TextBox>& boxes,
        float y_overlap_ratio = 0.50f,
        float max_gap_ratio = 1.5f,
        float max_h_diff = 1.8f
    );

    static bool isNoiseOrWatermark(const std::string& text);

    static float computeFillRatio(const cv::Mat& image, const cv::Rect& bbox);
    static int estimateFontWeight(float fill_ratio);

    static void extractColorsFast(
        const cv::Mat& image,
        const cv::Rect& rect,
        std::string& bg_hex,
        std::string& fg_hex,
        PurityInfo& purity
    );

    static bool classifyBubbleRole(
        const cv::Rect& bubble_box,
        int lines_count,
        float avg_line_h,
        float avg_fill_ratio,
        const std::string& bg_hex,
        const std::string& fg_hex,
        const std::string& text,
        const PurityInfo& purity,
        int img_w,
        int img_h,
        std::string& out_role,
        bool& out_is_ghost,
        std::string& out_surface,
        std::string& out_render_mode
    );

    static std::vector<BubbleItem> clusterAndStyle(
        const std::vector<TextLine>& lines,
        const cv::Mat& image,
        int start_y = 0,
        const std::string& lang = "korean"
    );

private:
    static bool shouldMergeDetailed(const TextLine& a, const TextLine& b);
    static std::string rgbToHex(int r, int g, int b);
};
