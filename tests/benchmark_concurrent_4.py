import asyncio
import json
import os
import re
import subprocess
import sys
import time
from typing import List, Dict, Any
import httpx


MANIFEST_PATH = "tests/data/manga18fx.com-muqi76dd-00nfa/manifest.json"
DATA_DIR = "tests/data/manga18fx.com-muqi76dd-00nfa"
SERVER_URL = "http://127.0.0.1:8765"
CONCURRENCY_LIMIT = 4


async def upload_worker(
    sem: asyncio.Semaphore,
    client: httpx.AsyncClient,
    slice_item: Dict[str, Any],
    results: List[Dict[str, Any]]
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
            resp = await client.post(f"{SERVER_URL}/api/v1/slice", files=files, data=data, timeout=30.0)
            client_elapsed = (time.perf_counter() - t0) * 1000.0
            if resp.status_code == 200:
                payload = resp.json()
                bubbles = payload.get("bubbles", [])
                server_cost = payload.get("cost_ms", client_elapsed)
                results.append({
                    "slice_index": slice_idx,
                    "start_y": start_y,
                    "end_y": end_y,
                    "bubbles_count": len(bubbles),
                    "client_ms": round(client_elapsed, 1),
                    "server_ms": round(server_cost, 1),
                    "sample_text": bubbles[0]["text"][:20] if bubbles else "<无对白>",
                    "success": True
                })
                print(f"  [完成 #{slice_idx:02d}] 耗时 {client_elapsed:5.1f}ms (服务端 {server_cost:5.1f}ms) | 气泡: {len(bubbles)} 个")
            else:
                print(f"  [失败 #{slice_idx:02d}] HTTP {resp.status_code}: {resp.text[:80]}")
                results.append({"slice_index": slice_idx, "success": False, "client_ms": round(client_elapsed, 1)})
        except Exception as e:
            client_elapsed = (time.perf_counter() - t0) * 1000.0
            print(f"  [异常 #{slice_idx:02d}] 错误: {str(e)}")
            results.append({"slice_index": slice_idx, "success": False, "client_ms": round(client_elapsed, 1)})


async def run_benchmark(num_slices: int = 63):
    # 1. 读取并解析 manifest
    if not os.path.exists(MANIFEST_PATH):
        print(f"Manifest 不存在: {MANIFEST_PATH}")
        return

    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    raw_slices = manifest.get("slices", {})
    slice_list = []

    for k, v in raw_slices.items():
        s_idx = v["slice_index"]
        filename = v["filename"]
        file_path = os.path.join(DATA_DIR, filename)
        if not os.path.exists(file_path):
            continue
        coords = v.get("coordinates", {})
        slice_list.append({
            "slice_index": s_idx,
            "filename": filename,
            "file_path": file_path,
            "start_y": coords.get("start_y", 0),
            "end_y": coords.get("end_y", 0),
            "width": coords.get("width", 720),
            "height": coords.get("height", 0)
        })

    slice_list.sort(key=lambda x: x["slice_index"])
    target_slices = slice_list[:num_slices]
    print(f"\n========================================================")
    print(f"  开始 4 并发压力测试: 总计 {len(target_slices)} 个切片")
    print(f"  目标服务器: {SERVER_URL}")
    print(f"  并发度上限: {CONCURRENCY_LIMIT}")
    print(f"========================================================\n")

    sem = asyncio.Semaphore(CONCURRENCY_LIMIT)
    results: List[Dict[str, Any]] = []

    t_wall_start = time.perf_counter()

    async with httpx.AsyncClient(limits=httpx.Limits(max_connections=CONCURRENCY_LIMIT * 2)) as client:
        tasks = [
            upload_worker(sem, client, s, results)
            for s in target_slices
        ]
        await asyncio.gather(*tasks)

    t_wall_total = time.perf_counter() - t_wall_start

    # 统计数据
    success_results = [r for r in results if r.get("success")]
    server_times = [r["server_ms"] for r in success_results]
    client_times = [r["client_ms"] for r in success_results]

    server_times.sort()
    client_times.sort()

    n = len(success_results)
    avg_server = sum(server_times) / n if n else 0
    p50_server = server_times[int(n * 0.50)] if n else 0
    p90_server = server_times[int(n * 0.90)] if n else 0
    p95_server = server_times[int(n * 0.95)] if n else 0
    fps = n / t_wall_total if t_wall_total > 0 else 0

    print(f"\n========================================================")
    print(f"  测试结果汇总 (4 并发流式测试)")
    print(f"========================================================")
    print(f"  总切片数:       {len(target_slices)} 张")
    print(f"  成功处理:       {n} 张 ({n/len(target_slices)*100:.1f}%)")
    print(f"  整话总耗时:     {t_wall_total:.2f} 秒")
    print(f"  系统综合吞吐量: {fps:.2f} 切片/秒 (FPS)")
    print(f"  单切片平均耗时: {avg_server:.1f} 毫秒")
    print(f"  P50 耗时:       {p50_server:.1f} 毫秒")
    print(f"  P90 耗时:       {p90_server:.1f} 毫秒")
    print(f"  P95 耗时:       {p95_server:.1f} 毫秒")
    print(f"========================================================\n")


if __name__ == "__main__":
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 63
    asyncio.run(run_benchmark(count))
