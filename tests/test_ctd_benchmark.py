import cv2
import numpy as np
import onnxruntime as ort
import pyclipper
from shapely.geometry import Polygon
import time
import json
import os

def letterbox(img, target_size=1024):
    """
    Uniform scaling with aspect ratio preserved, pad with black on the right and bottom.
    """
    h, w = img.shape[:2]
    scale = target_size / max(h, w)
    new_w = int(round(w * scale))
    new_h = int(round(h * scale))
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    
    padded = np.zeros((target_size, target_size, 3), dtype=np.uint8)
    padded[:new_h, :new_w] = resized
    return padded, scale, (new_w, new_h)

def unclip_polygon(box, unclip_ratio=1.70):
    """
    Expand detected DBNet polygon back to full character height.
    """
    poly = Polygon(box)
    if poly.length == 0 or poly.area == 0:
        return None
    distance = poly.area * unclip_ratio / poly.length
    offset = pyclipper.PyclipperOffset()
    offset.AddPath(box.astype(np.int64).tolist(), pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
    expanded = offset.Execute(distance)
    if len(expanded) == 0:
        return None
    return np.array(expanded[0])

def box_score_fast(bitmap, box):
    """
    Calculate average probability score inside candidate contour.
    """
    h, w = bitmap.shape[:2]
    xmin = int(np.clip(np.floor(box[:, 0].min()), 0, w - 1))
    xmax = int(np.clip(np.ceil(box[:, 0].max()), 0, w - 1))
    ymin = int(np.clip(np.floor(box[:, 1].min()), 0, h - 1))
    ymax = int(np.clip(np.ceil(box[:, 1].max()), 0, h - 1))
    if xmax <= xmin or ymax <= ymin:
        return 0.0
    mask = np.zeros((ymax - ymin + 1, xmax - xmin + 1), dtype=np.uint8)
    shifted_box = box.copy()
    shifted_box[:, 0] -= xmin
    shifted_box[:, 1] -= ymin
    cv2.fillPoly(mask, [shifted_box.astype(np.int32)], 1)
    return float(cv2.mean(bitmap[ymin:ymax + 1, xmin:xmax + 1], mask)[0])

def run_benchmark(slice_path, model_path='models/comictextdetector.pt.onnx', output_dir='tests/output'):
    os.makedirs(output_dir, exist_ok=True)
    orig_img = cv2.imread(slice_path)
    if orig_img is None:
        raise FileNotFoundError(f"Failed to read image: {slice_path}")
    orig_h, orig_w = orig_img.shape[:2]
    
    # 1. Preprocessing (Letterbox downscale into 1024)
    t0 = time.perf_counter()
    padded_img, scale, (new_w, new_h) = letterbox(orig_img, 1024)
    rgb = cv2.cvtColor(padded_img, cv2.COLOR_BGR2RGB)
    blob = rgb.transpose((2, 0, 1)).astype(np.float32) / 255.0
    blob = np.expand_dims(blob, axis=0)
    t_pre = (time.perf_counter() - t0) * 1000
    
    # 2. ONNX Forward Inference (Single pass)
    sess = ort.InferenceSession(model_path, providers=['CPUExecutionProvider'])
    t1 = time.perf_counter()
    out = sess.run(None, {'images': blob})
    t_inf = (time.perf_counter() - t1) * 1000
    
    blk_arr, seg_arr, det_arr = out
    
    # 3. Postprocessing
    t2 = time.perf_counter()
    text_prob = det_arr[0, 0]
    valid_bitmap = np.zeros_like(text_prob, dtype=np.uint8)
    valid_bitmap[:new_h, :new_w] = (text_prob[:new_h, :new_w] > 0.30).astype(np.uint8)
    
    contours, _ = cv2.findContours(valid_bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    
    box_thresh = 0.50
    unclip_ratio = 1.70
    text_lines = []
    
    for cnt in contours:
        if len(cnt) < 3:
            continue
        rect = cv2.minAreaRect(cnt)
        if min(rect[1]) < 3:
            continue
        score = box_score_fast(text_prob, cnt.squeeze(1))
        if score < box_thresh:
            continue
            
        box_pts = cv2.boxPoints(rect)
        expanded = unclip_polygon(box_pts, unclip_ratio=unclip_ratio)
        if expanded is None or len(expanded) < 3:
            continue
            
        # Map back to original image
        expanded_orig = expanded.astype(np.float64) / scale
        expanded_orig[:, 0] = np.clip(expanded_orig[:, 0], 0, orig_w)
        expanded_orig[:, 1] = np.clip(expanded_orig[:, 1], 0, orig_h)
        text_lines.append({
            'polygon': expanded_orig.astype(np.int32).tolist(),
            'score': round(score, 3)
        })
    
    # Postprocess bubbles (blk)
    raw_blks = blk_arr[0]
    confs = raw_blks[:, 4]
    candidate_mask = confs > 0.40
    cand_blks = raw_blks[candidate_mask]
    
    bubbles = []
    if len(cand_blks) > 0:
        bx, by, bw, bh = cand_blks[:, 0], cand_blks[:, 1], cand_blks[:, 2], cand_blks[:, 3]
        b_scores = cand_blks[:, 4]
        x1 = bx - bw / 2
        y1 = by - bh / 2
        
        boxes_for_nms = []
        scores_for_nms = []
        for i in range(len(cand_blks)):
            if x1[i] >= new_w or y1[i] >= new_h:
                continue
            boxes_for_nms.append([int(x1[i]), int(y1[i]), int(bw[i]), int(bh[i])])
            scores_for_nms.append(float(b_scores[i]))
            
        if len(boxes_for_nms) > 0:
            indices = cv2.dnn.NMSBoxes(boxes_for_nms, scores_for_nms, score_threshold=0.40, nms_threshold=0.35)
            if len(indices) > 0:
                indices = indices.flatten()
                for idx in indices:
                    x, y, w, h = boxes_for_nms[idx]
                    ox1 = max(0, min(orig_w, int(round(x / scale))))
                    oy1 = max(0, min(orig_h, int(round(y / scale))))
                    ox2 = max(0, min(orig_w, int(round((x + w) / scale))))
                    oy2 = max(0, min(orig_h, int(round((y + h) / scale))))
                    bubbles.append({
                        'xyxy': [ox1, oy1, ox2, oy2],
                        'score': round(scores_for_nms[idx], 3)
                    })
    
    t_post = (time.perf_counter() - t2) * 1000
    t_total = (time.perf_counter() - t0) * 1000
    
    # 4. Generate Visual Image
    vis_img = orig_img.copy()
    # Draw speech bubbles in Blue
    for b in bubbles:
        bx1, by1, bx2, by2 = b['xyxy']
        cv2.rectangle(vis_img, (bx1, by1), (bx2, by2), (255, 120, 0), 3) # Blue-ish/Cyan in BGR
        cv2.putText(vis_img, f"Bubble {b['score']}", (bx1, max(20, by1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 120, 0), 2)
                    
    # Draw text lines in Green
    for t in text_lines:
        pts = np.array(t['polygon'], dtype=np.int32)
        cv2.polylines(vis_img, [pts], isClosed=True, color=(0, 255, 0), thickness=2)
        top_left = pts[0]
        cv2.putText(vis_img, f"{t['score']}", (top_left[0], max(15, top_left[1] - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 220, 0), 1)
                    
    vis_path = os.path.join(output_dir, os.path.basename(slice_path).replace('.jpg', '_annotated.jpg'))
    cv2.imwrite(vis_path, vis_img)
    
    result = {
        "slice_file": os.path.basename(slice_path),
        "visual_output": vis_path,
        "original_resolution": [orig_w, orig_h],
        "scaled_resolution": [new_w, new_h],
        "scale_factor": round(scale, 4),
        "convolution_passes": 1,
        "timing_ms": {
            "preprocess": round(t_pre, 2),
            "inference": round(t_inf, 2),
            "postprocess": round(t_post, 2),
            "total": round(t_total, 2)
        },
        "detections_summary": {
            "bubbles_count": len(bubbles),
            "text_lines_count": len(text_lines)
        },
        "bubbles": bubbles,
        "text_lines": text_lines
    }
    return result

if __name__ == '__main__':
    test_slice = 'tests/data/manga18fx.com-muqi76dd-00nfa/slice_000003_Y000004809_000006704.jpg'
    res = run_benchmark(test_slice)
    print("\n================ BENCHMARK RESULT ================")
    print(json.dumps(res, indent=2, ensure_ascii=False))
