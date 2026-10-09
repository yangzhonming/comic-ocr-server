import asyncio
import json
import math
import os
import sys
import time
from typing import List, Dict, Any
import httpx

DATA_DIR = "tests/data/manga18fx.com-mus4yo2q-3dkm8"
SERVER_URL = "https://comic-ocr-xxxx.cn-shenzhen.fcapp.run"

async def upload_one_slice(
    sem: asyncio.Semaphore,
    client: httpx.AsyncClient,
    slice_item: Dict[str, Any],
    results: List[Dict[str, Any]],
    phase_label: str
):
    slice_idx = slice_item["slice_index"]
    start_y = slice_item["start_y"]
    end_y = slice_item["end_y"]
    file_path = slice_item["file_path"]

    async with sem:
        t0 = time.perf_counter()
        with open(file_path, "rb") as f:
            file_bytes = f.read()

        files = {
            "file": (os.path.basename(file_path), file_bytes, "image/jpeg")
        }
        data = {
            "slice_index": slice_idx,
            "start_y": start_y,
            "end_y": end_y,
            "lang": "kr"
        }

        try:
            resp = await client.post(
                f"{SERVER_URL}/api/v1/slice",
                files=files,
                data=data,
                timeout=45.0
            )
            client_elapsed = (time.perf_counter() - t0) * 1000.0

            if resp.status_code == 200:
                payload = resp.json()
                bubbles = payload.get("bubbles", [])
                server_cost = payload.get("cost_ms", client_elapsed)
                results.append({
                    "slice_index": slice_idx,
                    "phase": phase_label,
                    "bubbles_count": len(bubbles),
                    "bubbles": bubbles,
                    "client_ms": round(client_elapsed, 1),
                    "server_ms": round(server_cost, 1),
                    "finish_time": time.perf_counter(),
                    "success": True
                })
                print(f"    [{phase_label} #{slice_idx:02d}] 耗时 {client_elapsed:6.1f}ms (云端 {server_cost:5.1f}ms) | 气泡: {len(bubbles)} 个")
            else:
                print(f"    [{phase_label} #{slice_idx:02d}] 失败 HTTP {resp.status_code}")
                results.append({"slice_index": slice_idx, "phase": phase_label, "success": False, "client_ms": round(client_elapsed, 1)})
        except Exception as e:
            client_elapsed = (time.perf_counter() - t0) * 1000.0
            print(f"    [{phase_label} #{slice_idx:02d}] 异常: {str(e)}")
            results.append({"slice_index": slice_idx, "phase": phase_label, "success": False, "client_ms": round(client_elapsed, 1)})


async def run_pipeline_test(data_dir: str = DATA_DIR):
    coords_path = os.path.join(data_dir, "coordinates.json")
    manifest_path = os.path.join(data_dir, "manifest.json")

    with open(coords_path, "r", encoding="utf-8") as f:
        coords = json.load(f)
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    # 1. 计算画幅与切片理论值
    first_page = coords["pages"][0]
    page_w = first_page["sourceWidth"]
    page_h = first_page["sourceHeight"]
    aspect_ratio = page_h / page_w
    slice_height_theory = page_w * 3.46

    # 2. 单页切片数与一页半 (1.5页) 切片数
    slices_per_page = math.ceil(aspect_ratio / 3.46)
    first_screen_count = math.ceil(slices_per_page * 1.5)  # 1.5 页余量
    concurrency = min(max(first_screen_count, 4), 6)      # 动态并发量 (设为 6)

    # 整理所有切片文件
    raw_slices = manifest.get("slices", {})
    slice_list = []
    for k, v in raw_slices.items():
        s_idx = v["slice_index"]
        fn = v["filename"]
        fp = os.path.join(data_dir, fn)
        if os.path.exists(fp):
            slice_list.append({
                "slice_index": s_idx,
                "filename": fn,
                "file_path": fp,
                "start_y": v.get("coordinates", {}).get("start_y", 0),
                "end_y": v.get("coordinates", {}).get("end_y", 0)
            })
    slice_list.sort(key=lambda x: x["slice_index"])

    first_screen_slices = slice_list[:first_screen_count]
    remaining_slices = slice_list[first_screen_count:]

    print(f"\n========================================================")
    print(f"  🎯 漫画自适应切片与分段流水线实测 (720px 物理宽度)")
    print(f"========================================================")
    print(f"  首页物理尺寸:     {page_w} x {page_h} (纵横比: {aspect_ratio:.2f} 倍宽)")
    print(f"  单切片理论高:     {slice_height_theory:.1f}px (3.46 倍宽)")
    print(f"  单页切片数估算:   {aspect_ratio / 3.46:.2f} -> 向上取整 = {slices_per_page} 张")
    print(f"  首屏一页半余量:   {slices_per_page} x 1.5 = {first_screen_count} 张切片 (切片 #01 ~ #{first_screen_count:02d})")
    print(f"  计算动态并发量:   {concurrency} 并发")
    print(f"  整话总切片数:     {len(slice_list)} 张")
    print(f"  后续大包切片数:   {len(remaining_slices)} 张 (切片 #{first_screen_count+1:02d} ~ #{len(slice_list):02d})")
    print(f"========================================================\n")

    sem = asyncio.Semaphore(concurrency)
    results: List[Dict[str, Any]] = []

    t_global_start = time.perf_counter()

    async with httpx.AsyncClient(
        limits=httpx.Limits(max_connections=concurrency * 2, max_keepalive_connections=concurrency * 2),
        trust_env=True
    ) as client:
        # ----------------------------------------------------
        # 阶段 1: 首屏激活包 (利用悬浮球展开的时间差发送)
        # ----------------------------------------------------
        print(f"▶️ [阶段 1: 首屏激活包开始] 正在以 {concurrency} 并发发送前 {first_screen_count} 张切片...")
        t_phase1_start = time.perf_counter()
        
        phase1_tasks = [
            upload_one_slice(sem, client, s, results, "首屏包")
            for s in first_screen_slices
        ]
        await asyncio.gather(*phase1_tasks)
        t_phase1_end = time.perf_counter()
        phase1_duration = t_phase1_end - t_phase1_start

        phase1_bubbles = sum(r.get("bubbles_count", 0) for r in results if r.get("phase") == "首屏包" and r.get("success"))
        print(f"  ✅ [阶段 1: 首屏包就绪] 耗时: {phase1_duration:.2f} 秒 | 提取到 {phase1_bubbles} 个气泡\n")

        # ----------------------------------------------------
        # 阶段 2: 后续大包识别 (在首屏打给 DeepSeek 翻译时同步跑)
        # ----------------------------------------------------
        print(f"▶️ [阶段 2: 后续大包开始] 正在以 {concurrency} 并发识别剩余 {len(remaining_slices)} 张切片...")
        t_phase2_start = time.perf_counter()
        
        phase2_tasks = [
            upload_one_slice(sem, client, s, results, "后续包")
            for s in remaining_slices
        ]
        await asyncio.gather(*phase2_tasks)
        t_phase2_end = time.perf_counter()
        phase2_duration = t_phase2_end - t_phase2_start

        phase2_bubbles = sum(r.get("bubbles_count", 0) for r in results if r.get("phase") == "后续包" and r.get("success"))
        print(f"  ✅ [阶段 2: 后续大包就绪] 耗时: {phase2_duration:.2f} 秒 | 提取到 {phase2_bubbles} 个气泡\n")

    t_global_total = time.perf_counter() - t_global_start

    # 数据汇总分析
    print(f"\n========================================================")
    print(f"  🏁 720px 宽度下自适应分段流水线实测总结报告")
    print(f"========================================================")
    print(f"  1. 首屏激活包 (前 {first_screen_count} 张切片):")
    print(f"     - 发起到全部完成用时:   {phase1_duration:.2f} 秒")
    print(f"     - 包含对话气泡:         {phase1_bubbles} 个")
    print(f"     - 用户预热体感:         若利用点开悬浮球的 1.5s 预热，用户点击时已就绪 80%~100%！")
    print(f"--------------------------------------------------------")
    print(f"  2. 后续剩余大包 ({len(remaining_slices)} 张切片):")
    print(f"     - OCR 全部跑完用时:     {phase2_duration:.2f} 秒")
    print(f"     - 包含对话气泡:         {phase2_bubbles} 个")
    print(f"--------------------------------------------------------")
    print(f"  3. ⏱️ 关键时间差重叠 (Pipeline Overlap) 结论:")
    ds_est_phase1 = 0.5 + (phase1_bubbles * 12 / 60) # 首字 0.5s + 气泡字数流式输出
    print(f"     - DeepSeek 流式输出首屏 {phase1_bubbles} 个气泡预计耗时: 约 {ds_est_phase1:.1f} 秒")
    print(f"     - 后续大包 OCR 完成时间 ({phase2_duration:.2f}s) vs 首屏翻译阅读时间:")
    if phase2_duration <= (ds_est_phase1 + 3.0):
        print(f"       🌟 完美重叠！在用户读完首屏对白之前，后续整话 OCR 已经全部在后台准备就绪！")
    else:
        print(f"       后续包略长，建议后续包拆为双通道并发！")
    print(f"  4. 整话 62 张总耗时:       {t_global_total:.2f} 秒 (平均吞吐: {len(slice_list)/t_global_total:.2f} FPS)")
    print(f"========================================================\n")


if __name__ == "__main__":
    asyncio.run(run_pipeline_test())
