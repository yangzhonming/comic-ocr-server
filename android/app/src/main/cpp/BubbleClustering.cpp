#include "BubbleClustering.h"

#include <opencv2/imgproc.hpp>
#include <algorithm>
#include <cmath>
#include <queue>
#include <regex>
#include <sstream>
#include <iomanip>
#include <unordered_map>
#include <unordered_set>
#include <numeric>
#include <cctype>

std::string BubbleClustering::trim(const std::string& str) {
    auto start = str.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return "";
    auto end = str.find_last_not_of(" \t\r\n");
    return str.substr(start, end - start + 1);
}

std::vector<uint32_t> BubbleClustering::utf8ToCodepoints(const std::string& str) {
    std::vector<uint32_t> cps;
    size_t i = 0;
    while (i < str.size()) {
        unsigned char c = static_cast<unsigned char>(str[i]);
        uint32_t cp = 0;
        size_t extra = 0;
        if (c < 0x80) {
            cp = c;
            extra = 0;
        } else if ((c & 0xE0) == 0xC0) {
            cp = c & 0x1F;
            extra = 1;
        } else if ((c & 0xF0) == 0xE0) {
            cp = c & 0x0F;
            extra = 2;
        } else if ((c & 0xF8) == 0xF0) {
            cp = c & 0x07;
            extra = 3;
        } else {
            i++;
            continue;
        }
        if (i + extra >= str.size()) break;
        bool valid = true;
        for (size_t k = 1; k <= extra; ++k) {
            unsigned char next_c = static_cast<unsigned char>(str[i + k]);
            if ((next_c & 0xC0) != 0x80) { valid = false; break; }
            cp = (cp << 6) | (next_c & 0x3F);
        }
        if (valid) {
            cps.push_back(cp);
            i += 1 + extra;
        } else {
            i++;
        }
    }
    return cps;
}

bool BubbleClustering::isHangulSyllable(uint32_t cp) {
    return (cp >= 0xAC00 && cp <= 0xD7A3) ||
           (cp >= 0x1100 && cp <= 0x11FF) ||
           (cp >= 0x3130 && cp <= 0x318F);
}

bool BubbleClustering::isWordChar(uint32_t cp) {
    if ((cp >= 'a' && cp <= 'z') || (cp >= 'A' && cp <= 'Z') || (cp >= '0' && cp <= '9') || cp == '_') {
        return true;
    }
    if (isHangulSyllable(cp)) {
        return true;
    }
    if (cp >= 0x00C0 && cp <= 0x024F) {
        return true;
    }
    return false;
}

bool BubbleClustering::hasDialoguePunct(const std::string& text) {
    if (text.empty()) return false;
    for (size_t i = 0; i < text.size(); ++i) {
        unsigned char c = static_cast<unsigned char>(text[i]);
        if (c == '~' || c == '!' || c == '?') return true;
        if (c == '.' && i + 1 < text.size() && text[i + 1] == '.') return true;
        if (c == 0xC2 && i + 1 < text.size()) {
            unsigned char c2 = static_cast<unsigned char>(text[i + 1]);
            if (c2 == 0xBF || c2 == 0xA1) return true; // ¿ or ¡
        }
        if (c == 0xE2 && i + 2 < text.size()) {
            unsigned char c2 = static_cast<unsigned char>(text[i + 1]);
            unsigned char c3 = static_cast<unsigned char>(text[i + 2]);
            if (c2 == 0x80 && c3 == 0xA6) return true; // … (U+2026)
        }
        if (c == 0xEF && i + 2 < text.size()) {
            unsigned char c2 = static_cast<unsigned char>(text[i + 1]);
            unsigned char c3 = static_cast<unsigned char>(text[i + 2]);
            if (c2 == 0xBC && (c3 == 0x81 || c3 == 0x9F)) return true; // ！ or ？
            if (c2 == 0xBD && c3 == 0x9E) return true; // ～
        }
    }
    return false;
}

bool BubbleClustering::hasDialogueWords(const std::string& text) {
    if (text.empty()) return false;
    std::vector<uint32_t> cps = utf8ToCodepoints(text);
    if (cps.empty()) return false;

    // Korean dialogue particles / pronouns: 난, 이, 그, 저, 에, 는, 은, 가, 을, 를
    static const std::unordered_set<uint32_t> kr_words = {
        0xB09C, // 난
        0xC774, // 이
        0xADF8, // 그
        0xC800, // 저
        0xC5D0, // 에
        0xB294, // 는
        0xC740, // 은
        0xAC00, // 가
        0xC744, // 을
        0xB97C  // 를
    };

    // Latin dialogue words (lowercase)
    static const std::unordered_set<std::string> latin_words = {
        "de", "que", "un", "una", "los", "las", "el", "la", "es", "con", "en", "por", "para",
        "the", "and", "you", "that", "was", "for", "are", "with", "his", "they"
    };

    size_t i = 0;
    while (i < cps.size()) {
        if (!isWordChar(cps[i])) {
            i++;
            continue;
        }

        size_t start = i;
        bool is_all_ascii = true;
        std::string ascii_word;
        while (i < cps.size() && isWordChar(cps[i])) {
            uint32_t cp = cps[i];
            if (cp < 128) {
                ascii_word += static_cast<char>(std::tolower(static_cast<int>(cp)));
            } else {
                is_all_ascii = false;
            }
            i++;
        }
        size_t word_len = i - start;

        if (word_len == 1 && kr_words.count(cps[start])) {
            return true;
        }

        if (is_all_ascii && latin_words.count(ascii_word)) {
            return true;
        }
    }

    return false;
}

std::string BubbleClustering::rgbToHex(int r, int g, int b) {
    std::stringstream ss;
    ss << "#"
       << std::setfill('0') << std::setw(2) << std::hex << std::uppercase << std::clamp(r, 0, 255)
       << std::setfill('0') << std::setw(2) << std::hex << std::uppercase << std::clamp(g, 0, 255)
       << std::setfill('0') << std::setw(2) << std::hex << std::uppercase << std::clamp(g, 0, 255);
    return ss.str();
}

std::vector<TextBox> BubbleClustering::mergeHorizontalBoxes(
    const std::vector<TextBox>& boxes,
    float y_overlap_ratio,
    float max_gap_ratio,
    float max_h_diff
) {
    if (boxes.size() <= 1) return boxes;

    std::vector<TextBox> cur = boxes;
    bool merged = true;

    while (merged) {
        merged = false;
        int n = static_cast<int>(cur.size());
        for (int i = 0; i < n; ++i) {
            if (cur[i].bbox.width <= 0) continue;
            for (int j = i + 1; j < n; ++j) {
                if (cur[j].bbox.width <= 0) continue;

                const auto& a = cur[i].bbox;
                const auto& b = cur[j].bbox;

                int ha = a.height;
                int hb = b.height;
                if (ha <= 0 || hb <= 0) continue;

                if (std::max(ha, hb) > std::min(ha, hb) * max_h_diff) continue;

                int y_top = std::max(a.y, b.y);
                int y_bot = std::min(a.y + ha, b.y + hb);
                int overlap = std::max(0, y_bot - y_top);
                int min_h = std::min(ha, hb);
                if (static_cast<float>(overlap) / min_h < y_overlap_ratio) continue;

                int x_gap = std::max(0, std::max(a.x, b.x) - std::min(a.x + a.width, b.x + b.width));
                float avg_h = (ha + hb) / 2.0f;
                if (x_gap > avg_h * max_gap_ratio) continue;

                // Merge into i, clear j
                int nx1 = std::min(a.x, b.x);
                int ny1 = std::min(a.y, b.y);
                int nx2 = std::max(a.x + a.width, b.x + b.width);
                int ny2 = std::max(a.y + ha, b.y + hb);

                cur[i].bbox = cv::Rect(nx1, ny1, nx2 - nx1, ny2 - ny1);
                cur[i].score = std::max(cur[i].score, cur[j].score);
                cur[j].bbox = cv::Rect(0, 0, 0, 0);

                cur[i].points = {
                    cv::Point2f(nx1, ny1),
                    cv::Point2f(nx2, ny1),
                    cv::Point2f(nx2, ny2),
                    cv::Point2f(nx1, ny2)
                };

                merged = true;
                break;
            }
            if (merged) break;
        }

        std::vector<TextBox> next_cur;
        for (const auto& b : cur) {
            if (b.bbox.width > 0) next_cur.push_back(b);
        }
        cur = next_cur;
    }

    return cur;
}

bool BubbleClustering::isNoiseOrWatermark(const std::string& text) {
    std::string c = trim(text);
    if (c.empty()) return true;

    // 1. 单字符孤立噪音 (如 I, 1, l, -, …, —)，韩文字符单字拟声/叹词豁免
    std::vector<uint32_t> cps = utf8ToCodepoints(c);
    if (cps.empty()) return true;
    if (cps.size() <= 1) {
        if (!isHangulSyllable(cps[0])) {
            return true;
        }
    }

    // 2. 水印与扫图组广告正则黑名单 (对齐云端)
    std::string lower = c;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    static const std::vector<std::string> blacklists = {
        "http://", "https://", "www.",
        ".com", ".net", ".org", ".es", ".xyz", ".io", ".me", ".co", ".top", ".cc", ".site", ".online",
        "scan", "scans", "scanlation", "scanesp", "templescan", "leeronline",
        "traducido", "link en el navegador", "subido por", "t.me/", "discord.gg",
        "mejor calidad", "escribiendo este link"
    };
    for (const auto& kw : blacklists) {
        if (lower.find(kw) != std::string::npos) return true;
    }

    return false;
}


float BubbleClustering::computeFillRatio(const cv::Mat& image, const cv::Rect& bbox) {
    if (image.empty() || bbox.width < 4 || bbox.height < 4) return 0.35f;

    int x1 = std::max(0, bbox.x);
    int y1 = std::max(0, bbox.y);
    int x2 = std::min(image.cols, bbox.x + bbox.width);
    int y2 = std::min(image.rows, bbox.y + bbox.height);
    if (x2 <= x1 || y2 <= y1) return 0.35f;

    cv::Mat crop = image(cv::Rect(x1, y1, x2 - x1, y2 - y1));
    cv::Mat gray;
    if (crop.channels() == 3) {
        cv::cvtColor(crop, gray, cv::COLOR_BGR2GRAY);
    } else {
        gray = crop;
    }

    cv::Mat binary;
    cv::threshold(gray, binary, 0, 255, cv::THRESH_BINARY | cv::THRESH_OTSU);

    int edge_zeros = 0;
    int edge_total = 0;
    for (int c = 0; c < binary.cols; ++c) {
        if (binary.at<uchar>(0, c) == 0) edge_zeros++;
        if (binary.at<uchar>(binary.rows - 1, c) == 0) edge_zeros++;
        edge_total += 2;
    }
    for (int r = 0; r < binary.rows; ++r) {
        if (binary.at<uchar>(r, 0) == 0) edge_zeros++;
        if (binary.at<uchar>(r, binary.cols - 1) == 0) edge_zeros++;
        edge_total += 2;
    }

    bool is_dark_bg = (edge_total > 0 && (static_cast<float>(edge_zeros) / edge_total > 0.5f));
    uchar target_val = is_dark_bg ? 255 : 0;
    int text_px = 0;
    for (int r = 0; r < binary.rows; ++r) {
        const uchar* ptr = binary.ptr<uchar>(r);
        for (int c = 0; c < binary.cols; ++c) {
            if (ptr[c] == target_val) text_px++;
        }
    }

    int total_px = binary.rows * binary.cols;
    return total_px > 0 ? (static_cast<float>(text_px) / total_px) : 0.35f;
}

int BubbleClustering::estimateFontWeight(float fill_ratio) {
    return fill_ratio > 0.42f ? 700 : 400;
}

void BubbleClustering::extractColorsFast(
    const cv::Mat& image,
    const cv::Rect& rect,
    std::string& bg_hex,
    std::string& fg_hex,
    PurityInfo& purity
) {
    purity = PurityInfo();
    if (image.empty() || rect.width < 4 || rect.height < 4) {
        bg_hex = "#FFFFFF";
        fg_hex = "#000000";
        return;
    }

    int h = image.rows;
    int w = image.cols;
    int bx1 = std::max(0, rect.x);
    int by1 = std::max(0, rect.y);
    int bx2 = std::min(w, rect.x + rect.width);
    int by2 = std::min(h, rect.y + rect.height);
    int bw = bx2 - bx1;
    int bh = by2 - by1;

    if (bw < 4 || bh < 4) {
        bg_hex = "#FFFFFF";
        fg_hex = "#000000";
        return;
    }

    // 1. Cross-Cardinal Mid-Strip Sampling (避开内切四角，外扩 8~24px 跨过文字描边)
    int pad = std::max(8, std::min(24, static_cast<int>(std::round(std::min(bw, bh) * 0.14f))));
    int thick = std::max(2, std::min(4, static_cast<int>(std::round(pad * 0.3f))));

    int x_mid1 = bx1 + static_cast<int>(0.20f * bw);
    int x_mid2 = bx2 - static_cast<int>(0.20f * bw);
    int y_mid1 = by1 + static_cast<int>(0.20f * bh);
    int y_mid2 = by2 - static_cast<int>(0.20f * bh);

    int t_y1 = std::max(0, by1 - pad);
    int t_y2 = std::max(0, by1 - pad + thick);
    int b_y1 = std::min(h - thick, by2 + pad - thick);
    int b_y2 = std::min(h, by2 + pad);

    int l_x1 = std::max(0, bx1 - pad);
    int l_x2 = std::max(0, bx1 - pad + thick);
    int r_x1 = std::min(w - thick, bx2 + pad - thick);
    int r_x2 = std::min(w, bx2 + pad);

    std::vector<cv::Vec3b> strip_pixels;
    std::vector<cv::Vec3d> strip_medians;

    auto collectStrip = [&](int r1, int r2, int c1, int c2) {
        if (r2 <= r1 || c2 <= c1) return;
        std::vector<double> rs, gs, bs;
        for (int r = r1; r < r2; ++r) {
            for (int c = c1; c < c2; ++c) {
                const auto& col = image.at<cv::Vec3b>(r, c);
                strip_pixels.push_back(col);
                bs.push_back(col[0]);
                gs.push_back(col[1]);
                rs.push_back(col[2]);
            }
        }
        if (!bs.empty()) {
            std::sort(bs.begin(), bs.end());
            std::sort(gs.begin(), gs.end());
            std::sort(rs.begin(), rs.end());
            size_t mid = bs.size() / 2;
            strip_medians.push_back(cv::Vec3d(bs[mid], gs[mid], rs[mid]));
        }
    };

    collectStrip(t_y1, t_y2, x_mid1, x_mid2);
    collectStrip(b_y1, b_y2, x_mid1, x_mid2);
    collectStrip(y_mid1, y_mid2, l_x1, l_x2);
    collectStrip(y_mid1, y_mid2, r_x1, r_x2);

    cv::Vec3b bg_color(255, 255, 255);
    if (!strip_pixels.empty()) {
        // Quantize to 16-level buckets
        std::unordered_map<int, int> bucket_counts;
        for (const auto& px : strip_pixels) {
            int qb = px[0] / 16;
            int qg = px[1] / 16;
            int qr = px[2] / 16;
            int key = (qb << 8) | (qg << 4) | qr;
            bucket_counts[key]++;
        }

        std::vector<int> counts;
        for (const auto& kv : bucket_counts) counts.push_back(kv.second);
        std::sort(counts.begin(), counts.end(), std::greater<int>());

        float total_px = static_cast<float>(strip_pixels.size());
        purity.top1_purity = counts.empty() ? 1.0f : (counts[0] / total_px);
        int top3_sum = 0;
        for (size_t i = 0; i < std::min<size_t>(3, counts.size()); ++i) top3_sum += counts[i];
        purity.top3_purity = top3_sum / total_px;
        purity.num_colors = static_cast<int>(bucket_counts.size());

        // Median luminance standard deviation across strips
        if (!strip_medians.empty()) {
            std::vector<float> med_lums;
            std::vector<double> m_bs, m_gs, m_rs;
            for (const auto& m : strip_medians) {
                m_bs.push_back(m[0]);
                m_gs.push_back(m[1]);
                m_rs.push_back(m[2]);
                med_lums.push_back(static_cast<float>(0.114 * m[0] + 0.587 * m[1] + 0.299 * m[2]));
            }

            auto calcMedian = [](std::vector<double>& v) -> double {
                if (v.empty()) return 0.0;
                std::sort(v.begin(), v.end());
                size_t n = v.size();
                if (n % 2 == 1) return v[n / 2];
                return (v[n / 2 - 1] + v[n / 2]) / 2.0;
            };

            bg_color[0] = static_cast<uchar>(std::clamp<int>(std::round(calcMedian(m_bs)), 0, 255));
            bg_color[1] = static_cast<uchar>(std::clamp<int>(std::round(calcMedian(m_gs)), 0, 255));
            bg_color[2] = static_cast<uchar>(std::clamp<int>(std::round(calcMedian(m_rs)), 0, 255));

            float mean_lum = std::accumulate(med_lums.begin(), med_lums.end(), 0.0f) / med_lums.size();
            float sq_sum = 0;
            for (float l : med_lums) sq_sum += (l - mean_lum) * (l - mean_lum);
            purity.lum_std = std::sqrt(sq_sum / med_lums.size());
            purity.is_messy = (purity.top1_purity < 0.35f && purity.num_colors > 45 && purity.lum_std > 40.0f);
        }
    }

    // 2. 文本核心区 2-中心 KMeans 提取前景色
    cv::Mat tc_crop = image(cv::Rect(bx1, by1, bw, bh));
    cv::Mat scale_crop;
    if (bw * bh > 1024) {
        float scale = std::sqrt(1024.0f / (bw * bh));
        cv::resize(tc_crop, scale_crop, cv::Size(std::max(1, static_cast<int>(bw * scale)), std::max(1, static_cast<int>(bh * scale))), 0, 0, cv::INTER_AREA);
    } else {
        scale_crop = tc_crop;
    }

    cv::Mat pixels(scale_crop.rows * scale_crop.cols, 3, CV_32F);
    for (int r = 0; r < scale_crop.rows; ++r) {
        for (int c = 0; c < scale_crop.cols; ++c) {
            const auto& col = scale_crop.at<cv::Vec3b>(r, c);
            int idx = r * scale_crop.cols + c;
            pixels.at<float>(idx, 0) = col[0];
            pixels.at<float>(idx, 1) = col[1];
            pixels.at<float>(idx, 2) = col[2];
        }
    }

    cv::Mat labels, centers;
    cv::TermCriteria criteria(cv::TermCriteria::EPS + cv::TermCriteria::MAX_ITER, 8, 1.0);
    cv::kmeans(pixels, 2, labels, criteria, 1, cv::KMEANS_PP_CENTERS, centers);

    cv::Vec3f bg_f(bg_color[0], bg_color[1], bg_color[2]);
    cv::Vec3f c0(centers.at<float>(0, 0), centers.at<float>(0, 1), centers.at<float>(0, 2));
    cv::Vec3f c1(centers.at<float>(1, 0), centers.at<float>(1, 1), centers.at<float>(1, 2));
    float d0 = cv::norm(c0 - bg_f);
    float d1 = cv::norm(c1 - bg_f);

    cv::Vec3f chosen = (d0 > d1) ? c0 : c1;
    cv::Vec3b text_color(
        static_cast<uchar>(std::clamp<int>(std::round(chosen[0]), 0, 255)),
        static_cast<uchar>(std::clamp<int>(std::round(chosen[1]), 0, 255)),
        static_cast<uchar>(std::clamp<int>(std::round(chosen[2]), 0, 255))
    );

    // 3. WCAG 感知亮度差值保底 (亮度差 >= 55)
    float bg_lum = 0.114f * bg_color[0] + 0.587f * bg_color[1] + 0.299f * bg_color[2];
    float tx_lum = 0.114f * text_color[0] + 0.587f * text_color[1] + 0.299f * text_color[2];
    if (std::abs(bg_lum - tx_lum) < 55.0f) {
        if (bg_lum < 128.0f) {
            text_color = cv::Vec3b(255, 255, 255);
        } else {
            text_color = cv::Vec3b(0, 0, 0);
        }
    }

    bg_hex = rgbToHex(bg_color[2], bg_color[1], bg_color[0]);
    fg_hex = rgbToHex(text_color[2], text_color[1], text_color[0]);
}

bool BubbleClustering::classifyBubbleRole(
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
) {
    std::string clean_text = text;
    std::replace(clean_text.begin(), clean_text.end(), '\n', ' ');
    clean_text = trim(clean_text);

    float h_std = img_w * 0.085f;
    float height_ratio = avg_line_h / std::max(1.0f, h_std);

    auto hexToLumSat = [](const std::string& h) -> std::pair<float, float> {
        if (h.length() != 7) return {255.0f, 0.0f};
        int r = std::stoi(h.substr(1, 2), nullptr, 16);
        int g = std::stoi(h.substr(3, 2), nullptr, 16);
        int b = std::stoi(h.substr(5, 2), nullptr, 16);
        float lum = 0.299f * r + 0.587f * g + 0.114f * b;
        float sat = static_cast<float>(std::max({r, g, b}) - std::min({r, g, b}));
        return {lum, sat};
    };

    auto [bg_lum, bg_sat] = hexToLumSat(bg_hex);
    auto [fg_lum, fg_sat] = hexToLumSat(fg_hex);

    // 对话情绪标点与对白特征判断 (对齐云端)
    bool has_dialogue_punct = hasDialoguePunct(clean_text);
    bool has_dialogue_words = hasDialogueWords(clean_text);
    bool is_dialogue_text = has_dialogue_punct || has_dialogue_words;
    bool is_multi_line = (lines_count >= 2);

    // === 通道 A: 纯白标准气泡 ===
    bool is_pure_white = (bg_lum >= 215.0f && bg_sat <= 25.0f && purity.num_colors <= 28);
    if (is_pure_white) {
        out_role = "dialogue";
        out_is_ghost = false;
        out_surface = "white_solid";
        out_render_mode = "solid_patch";
        return true;
    }

    // === 通道 B: 平滑非白底色 (渐变气泡 / 平滑窗户/天空) ===
    bool is_solid_nonwhite = (purity.num_colors <= 28 && purity.top3_purity >= 0.55f);
    bool is_gradient_bubble = (is_multi_line && is_dialogue_text && bg_sat >= 25.0f && bg_lum >= 120.0f) ||
                              (has_dialogue_punct && (purity.num_colors <= 50 || purity.lum_std <= 35.0f) && bg_lum >= 90.0f);
    if (is_solid_nonwhite || is_gradient_bubble) {
        out_role = "dialogue";
        out_is_ghost = false;
        out_surface = "smooth_bg";
        out_render_mode = "glow_patch";
        return true;
    }

    // === 通道 C: 复杂杂乱背景 (衣服 / 场景道具 / 悬浮画外音 / 拟声词) ===
    bool is_vivid_color = (fg_sat >= 35.0f);
    bool is_hollow_font = (avg_fill_ratio < 0.18f);
    bool is_huge_scale = (height_ratio > 2.0f && fg_sat >= 15.0f);

    if (is_vivid_color || is_hollow_font || is_huge_scale) {
        out_role = "sfx";
        out_is_ghost = true;
        out_surface = "textured";
        out_render_mode = "sfx_overlay";
        return true;
    }

    // 2. 悬浮画外音: 必须具备对话情绪标点且多字成词 (Unicode 字符数 >= 3)
    size_t unicode_len = utf8ToCodepoints(clean_text).size();
    if (has_dialogue_punct && unicode_len >= 3) {
        out_role = "ambient";
        out_is_ghost = false;
        out_surface = "textured";
        out_render_mode = "outlined_overlay";
        return true;
    }

    // 3. 衣服印花 / 场景杂质决断: 既无拟声词特征，又无对话标点 -> 坚决 DROP 丢弃！
    out_role = "";
    out_is_ghost = false;
    out_surface = "textured";
    out_render_mode = "drop";
    return false;
}

bool BubbleClustering::shouldMergeDetailed(const TextLine& a, const TextLine& b) {
    const cv::Rect& ra = a.bbox;
    const cv::Rect& rb = b.bbox;

    float ha = static_cast<float>(ra.height);
    float hb = static_cast<float>(rb.height);
    float h_ratio = std::max(ha, hb) / std::max(1.0f, std::min(ha, hb));
    if (h_ratio > 2.2f) return false; // 拟声词隔离护盾

    float local_char_size = std::min(ha, hb);
    if (local_char_size <= 0.0f) return false;

    float center_y_a = ra.y + ha / 2.0f;
    float center_y_b = rb.y + hb / 2.0f;
    int h_gap = std::max(ra.x, rb.x) - std::min(ra.x + ra.width, rb.x + rb.width);
    int v_gap = std::max(ra.y, rb.y) - std::min(ra.y + ra.height, rb.y + rb.height);

    // 规则 A：同行横向合并 (水平排列且中心 Y 轴接近)
    if (std::abs(center_y_a - center_y_b) < local_char_size * 0.6f) {
        // 非对称碎片间距保护：若任一方为超短孤立碎片 (宽 < 1.3H)，限制其横向跨距
        bool is_tiny_fragment = std::min(ra.width, rb.width) < local_char_size * 1.3f;
        float effective_h_gap = local_char_size * (is_tiny_fragment ? 0.60f : 2.0f);
        if (h_gap < effective_h_gap) {
            return true;
        } else if (is_tiny_fragment) {
            return false;
        }
    }

    // 规则 B：同气泡纵向换行合并
    int x_overlap = std::max(0, std::min(ra.x + ra.width, rb.x + rb.width) - std::max(ra.x, rb.x));
    bool is_x_overlapped = (x_overlap > std::min(ra.width, rb.width) * 0.20f) || (x_overlap > local_char_size);

    if (is_x_overlapped) {
        float center_x_a = ra.x + ra.width / 2.0f;
        float center_x_b = rb.x + rb.width / 2.0f;
        float center_diff = std::abs(center_x_a - center_x_b);
        float left_diff = std::abs(ra.x - rb.x);
        float right_diff = std::abs((ra.x + ra.width) - (rb.x + rb.width));

        // 动态自适应容差
        float center_tol = std::max(14.0f, std::max(local_char_size * 0.48f, std::min(ra.width, rb.width) * 0.28f));
        float left_tol = std::max(12.0f, local_char_size * 0.38f);
        float right_tol = std::max(12.0f, local_char_size * 0.38f);

        bool is_center_aligned = (center_diff <= center_tol);
        bool is_left_aligned = (left_diff <= left_tol);
        bool is_right_aligned = (right_diff <= right_tol);

        if (!is_center_aligned && !is_left_aligned && !is_right_aligned) {
            return false;
        }

        if (v_gap <= 0) {
            return std::abs(center_y_a - center_y_b) < std::max(ha, hb) * 1.3f;
        }
        if (v_gap < local_char_size * 1.3f) {
            return true;
        }
    }

    return false;
}

std::vector<BubbleItem> BubbleClustering::clusterAndStyle(
    const std::vector<TextLine>& lines,
    const cv::Mat& image,
    int start_y,
    const std::string& lang
) {
    int n = static_cast<int>(lines.size());
    if (n == 0) return {};

    // 预先计算每行的 fill_ratio
    std::vector<TextLine> processed_lines = lines;
    for (auto& tl : processed_lines) {
        tl.fill_ratio = computeFillRatio(image, tl.bbox);
    }

    // BFS 邻接图构建
    std::vector<std::vector<int>> adj(n);
    for (int i = 0; i < n; ++i) {
        for (int j = i + 1; j < n; ++j) {
            if (shouldMergeDetailed(processed_lines[i], processed_lines[j])) {
                adj[i].push_back(j);
                adj[j].push_back(i);
            }
        }
    }

    std::vector<bool> visited(n, false);
    std::vector<BubbleItem> bubbles;

    for (int i = 0; i < n; ++i) {
        if (visited[i]) continue;

        std::vector<int> component_indices;
        std::queue<int> q;
        q.push(i);
        visited[i] = true;

        while (!q.empty()) {
            int u = q.front();
            q.pop();
            component_indices.push_back(u);

            for (int v : adj[u]) {
                if (!visited[v]) {
                    visited[v] = true;
                    q.push(v);
                }
            }
        }

        std::vector<TextLine> component;
        for (int idx : component_indices) {
            component.push_back(processed_lines[idx]);
        }

        // === 核心机制：物理行分桶 (Line Bucketization) ===
        // 按 Y 轴初步排序
        std::sort(component.begin(), component.end(), [](const TextLine& a, const TextLine& b) {
            return a.bbox.y < b.bbox.y;
        });

        std::vector<std::vector<TextLine>> physical_lines;
        for (const auto& it : component) {
            bool placed = false;
            for (auto& pline : physical_lines) {
                const auto& ref = pline[0];
                int y_top = std::max(it.bbox.y, ref.bbox.y);
                int y_bot = std::min(it.bbox.y + it.bbox.height, ref.bbox.y + ref.bbox.height);
                int overlap = std::max(0, y_bot - y_top);
                int min_h = std::min(it.bbox.height, ref.bbox.height);
                if (min_h > 0 && (static_cast<float>(overlap) / min_h) >= 0.50f) {
                    pline.push_back(it);
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                physical_lines.push_back({it});
            }
        }

        // 每行内部按 X 轴从左到右排序，同行以空格连接；行间插入 \n
        std::vector<std::string> formatted_lines;
        for (auto& pline : physical_lines) {
            std::sort(pline.begin(), pline.end(), [](const TextLine& a, const TextLine& b) {
                return a.bbox.x < b.bbox.x;
            });
            std::string line_str;
            for (const auto& item : pline) {
                std::string trimmed = trim(item.text);
                if (trimmed.empty()) continue;
                if (!line_str.empty()) line_str += " ";
                line_str += trimmed;
            }
            if (!line_str.empty()) {
                formatted_lines.push_back(line_str);
            }
        }

        std::string merged_text;
        for (size_t l_idx = 0; l_idx < formatted_lines.size(); ++l_idx) {
            if (l_idx > 0) merged_text += "\n";
            merged_text += formatted_lines[l_idx];
        }

        if (merged_text.empty()) continue;

        // 计算气泡大包围盒
        int min_x = 100000, min_y = 100000, max_x = 0, max_y = 0;
        float total_score = 0.0f;
        int total_h = 0;
        float total_fill = 0.0f;

        for (const auto& item : component) {
            min_x = std::min(min_x, item.bbox.x);
            min_y = std::min(min_y, item.bbox.y);
            max_x = std::max(max_x, item.bbox.x + item.bbox.width);
            max_y = std::max(max_y, item.bbox.y + item.bbox.height);

            total_score += item.rec_score;
            total_h += item.bbox.height;
            total_fill += item.fill_ratio;
        }

        cv::Rect bubble_box(min_x, min_y, max_x - min_x, max_y - min_y);
        float avg_score = total_score / component.size();
        float avg_line_h = static_cast<float>(total_h) / component.size();
        float avg_fill = total_fill / component.size();

        // 精准色彩与纯净度提取
        std::string bg_hex, fg_hex;
        PurityInfo purity;
        extractColorsFast(image, bubble_box, bg_hex, fg_hex, purity);

        // 分层物理决策树裁决气泡类型 (如遇衣服 Logo 直接丢弃)
        std::string role, surface, render_mode;
        bool is_ghost = false;
        bool keep = classifyBubbleRole(
            bubble_box,
            static_cast<int>(physical_lines.size()),
            avg_line_h,
            avg_fill,
            bg_hex,
            fg_hex,
            merged_text,
            purity,
            image.cols,
            image.rows,
            role,
            is_ghost,
            surface,
            render_mode
        );

        if (!keep || render_mode == "drop") {
            continue; // 衣服印花 / 场景杂质丢弃！
        }

        BubbleItem bubble;
        bubble.box_rel = {bubble_box.x, bubble_box.y, bubble_box.width, bubble_box.height};
        bubble.box_abs = {bubble_box.x, bubble_box.y + start_y, bubble_box.width, bubble_box.height};
        bubble.text = merged_text;
        bubble.bg = bg_hex;
        bubble.fg = fg_hex;
        bubble.score = avg_score;
        bubble.size = std::max(12, static_cast<int>(std::round(avg_line_h * 0.85f)));
        bubble.weight = estimateFontWeight(avg_fill); // 动态自适应字重 (400 vs 700)
        bubble.role = role;
        bubble.is_ghost = is_ghost;
        bubble.surface = surface;
        bubble.render_mode = render_mode;

        bubbles.push_back(bubble);
    }

    return bubbles;
}
