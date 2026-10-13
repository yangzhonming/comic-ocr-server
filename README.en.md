# ComicFlow / ComicOCR - Real-Time Web Comic Streaming Translation System (Cloud & Mobile Edge Dual-Engine)

[English](README.en.md) | [简体中文](README.md)

> 📖 **Full Technical Documentation**: For comprehensive architecture designs, algorithmic implementations, and deployment guides, please refer to [English Architecture & Deployment Guide](docs/ARCHITECTURE.en.md) | [《中文架构与部署指南》](docs/ARCHITECTURE.zh-CN.md).
>
> 📦 **Latest Release Downloads ([GitHub Releases v1.0.4](https://github.com/yangzhonming/comic-ocr-server/releases/tag/v1.0.4))**:
> - 📱 **Android Mobile Engine**: [`ComicOCR-v1.0.3.apk`](https://github.com/yangzhonming/comic-ocr-server/releases/download/v1.0.4/ComicOCR-v1.0.3.apk) (Built-in 1px transparent overlay and full anti-freeze keep-alive suite)
> - 🧩 **Web Extension**: [`comic-translate-plugin-v1.0.4.zip`](https://github.com/yangzhonming/comic-ocr-server/releases/download/v1.0.4/comic-translate-plugin-v1.0.4.zip) (Integrated classic green "译" logo, cyber dark popup UI, and Plan A native sentinel)
> - 🛠️ **Algorithm Playground**: [`启动算法演练台.bat`](启动算法演练台.bat) (One-click launcher for offline slicing and OCR parameter calibration)

> 🚀 **Dual-Engine Architecture: Mobile Local High-Speed OCR Engine (ComicOCR v1.0.3) + Cloud Serverless Container Service + Immersive Web Comic Extension (v1.0.4)**
>
> ComicTranslate is an end-to-end web comic recognition and translation pipeline supporting **"Client-side sensing & slicing + Dual-engine OCR (Edge & Cloud) + Direct streaming LLM translation"**:
> 1. **Mobile Local Edge Engine (ComicOCR v1.0.3)**: Runs deep learning models directly on Android devices with **1px transparent overlay + WakeLock + WifiLock + Battery Whitelist** anti-freeze mechanisms, achieving **zero server costs, ultra-low power consumption, full privacy, and offline capability**;
> 2. **Cloud Serverless Microservice (Backend v1.0.0)**: Tailored for CPU container environments (Aliyun FC 3.0 / Docker), offering in-memory direct decoding and dynamic threshold configuration;
> 3. **Universal Web Extension (v1.0.4)**: Compatible with Android browsers (Lemur / Kiwi) and desktop Chromium (Chrome / Edge / Brave). Features three sensitivity modes (🟢 Sensitive / 🟡 Balanced / 🔴 Strict), custom endpoint routing, and comic profile memory.

---

## Table of Contents
- [1. Dual-Engine System Architecture](#1-dual-engine-system-architecture)
- [2. Mobile Edge Engine ComicOCR (Android)](#2-mobile-edge-engine-comicocr-android)
- [3. Cloud Serverless Backend (FastAPI + ONNX)](#3-cloud-serverless-backend-fastapi--onnx)
- [4. Web Extension Pipeline (v1.0.4)](#4-web-extension-pipeline-v104)
- [5. Quick Start & Deployment Guide](#5-quick-start--deployment-guide)
  - [Mobile App Installation](#mobile-app-installation)
  - [Web Extension Installation](#web-extension-installation)
  - [Cloud Docker Deployment](#cloud-docker-deployment)
  - [Local Algorithm Playground](#local-algorithm-playground)
- [6. Project Directory Tree](#6-project-directory-tree)
- [7. License & Acknowledgements](#7-license--acknowledgements)

---

## 1. Dual-Engine System Architecture

```mermaid
flowchart TD
    subgraph Browser ["Frontend Environment (Chrome / Kiwi / Lemur Extension v1.0.4)"]
        DOM["DOM Tree & Image Sniffing"] --> Classifier["1. Comic Layout Classifier (Geometric Heuristics)"]
        Classifier --> Locator["2. Container Locator & Anchor Detection (LCA Algorithm)"]
        Locator --> VirtualStrip["3. Virtual Strip Coordinate System (Unified Y-Axis)"]
        VirtualStrip --> Slicer["4. Adaptive Valley Seam Slicing (Text Protection)"]
        Slicer --> Router{"Network Routing"}
        Router -->|"Mode A: Local Engine (:8080)"| NetBridge["Background Worker Relay (PNA Bypass)"]
        Router -->|"Mode B: Cloud Engine (HTTPS)"| CloudAPI["Direct Fetch API"]
        
        RecJSON["Bubble Coordinates, Text & Styles"] --> PatchRenderer["DOM Native Patch Renderer"]
        PatchRenderer --> LLMClient["Streaming Translation Dispatcher (First-Slice Eager + Queue)"]
        LLMClient -.->|"Per-Line Parsing"| PatchUpdater["Dynamic Font & Layout Reflow"]
    end

    subgraph MobileEngine ["Mode A: Mobile Local Engine (ComicOCR Android App)"]
        NetBridge --> Ktor["Ktor CIO Async Server (:8080)"]
        Ktor --> Mutex["Coroutine Mutex (GPU Command Serialization)"]
        Mutex --> JNI["JNI / C++20 Native Layer"]
        JNI --> NCNN["ncnn Vulkan GPU Inference (FP16 Mixed Precision)"]
        JNI --> BubbleCpp["Box Merging & Bubble Clustering & Quantization"]
        BubbleCpp --> RecJSON
        
        KeepAliveLayer["1px Transparent Overlay & Locks (Anti-Freeze Matrix)"] -.-> MobileEngine
    end

    subgraph CloudOCR ["Mode B: Cloud Microservice (Docker / Serverless)"]
        CloudAPI --> FastAPISrv["FastAPI + In-Memory Decoding (Zero Disk I/O)"]
        FastAPISrv --> ONNX["ONNX Runtime + RapidOCR"]
        FastAPISrv --> MergePy["Horizontal Merging & Containment Suppression"]
        MergePy --> BFSPy["BFS Graph Clustering & Border Ring Sampling"]
        BFSPy --> RecJSON
    end

    subgraph LLMCloud ["Large Language Model Services (DeepSeek / OpenAI Compatible)"]
        LLMClient ==>|"SSE Streaming Connection"| LLMCloud
    end
```

---

## 2. Mobile Edge Engine ComicOCR (Android)

Located under [`android/`](file:///android/), the Android native app provides a private, zero-latency local HTTP OCR service directly on mobile devices:
* **Embedded Ktor CIO**: Lightweight coroutine asynchronous server listening on `127.0.0.1:8080`;
* **🛡️ Zero-Freeze Keep-Alive Matrix**:
  - **1px Transparent Overlay (`SYSTEM_ALERT_WINDOW`)**: Attaches an imperceptible $1 \times 1$ px window via `WindowManager`, informing the system that the app possesses an active visible surface to **exempt the process from Linux kernel Cgroup v2 Freezer suspension**;
  - **Persistent Partial WakeLock**: Keeps CPU cores active during background browser reading;
  - **High-Performance WifiLock**: Prevents wireless chips from entering low-power sleep states;
  - **Battery Whitelist Prompt**: Bypasses OEM-specific aggressive Doze throttling.
* **C++20 NDK & ncnn Vulkan Acceleration**:
  - Direct JNI memory buffer transfer without intermediate bitmap duplication;
  - Executes DBNet and CRNN/CTC inference via **FP16 mixed precision** on Adreno / Mali GPUs, halving memory bandwidth and heat generation.

---

## 3. Cloud Serverless Backend (FastAPI + ONNX)

Located under [`app/`](file:///app/), the Python microservice is designed for elastic cloud environments:
* **Zero Disk I/O**: Direct stream memory decoding via `np.frombuffer` and `cv2.imdecode`;
* **Lifespan Warmup**: Preloads Korean, English, Japanese, and Russian model pools at startup to prevent first-request cold starts;
* **Thread Optimization**: Restricts OpenCV internal threads (`cv2.setNumThreads(1)`) to avoid CPU context-switching conflicts with ONNX Runtime thread pools;
* **Layout Analysis**: Horizontal text line fusion, nested box containment suppression, and BFS bubble clustering.

---

## 4. Web Extension Pipeline (v1.0.4)

Located under [`plugin/`](file:///plugin/):
* **Classic Logo & Dark Cyber UI**: Polished extension branding with live status indicators (🟢 Recognized / 🔴 Blocked / 🟡 Waiting);
* **Interaction Gestures**:
  - **Single-Tap**: Instantly start or stop the translation pipeline;
  - **Long-Press (0.5s)**: Open or dismiss the settings drawer.
* **Virtual Strip System**: Pure mathematical coordinate projection preventing memory crashes on long web comics;
* **Adaptive Valley Seam Slicing ($3.46W$)**: Automatically targets background white gaps near $3.46 \times \text{width}$, strictly avoiding speech balloons;
* **DNR Cross-Origin Bypass**: Declarative Net Request rules rewrite response headers, preventing `Tainted canvas` errors without third-party proxies.

---

## 5. Quick Start & Deployment Guide

### Mobile App Installation
* Download and install [`ComicOCR-v1.0.3.apk`](ComicOCR-v1.0.3.apk) on your 64-bit Android device (Android 8.0+);
* Launch the app, grant the **Anti-Freeze Overlay** and **Battery Whitelist** permissions, and tap `▶ START SERVICE`.

### Web Extension Installation
* **Desktop (Chrome / Edge / Brave)**: Extract [`comic-translate-plugin-v1.0.4.zip`](comic-translate-plugin-v1.0.4.zip) or navigate to `chrome://extensions/`, enable Developer Mode, and click "Load unpacked";
* **Android (Lemur / Kiwi Browser)**: Install the browser, open its extension manager, and import `comic-translate-plugin-v1.0.4.zip`.

### Cloud Docker Deployment
```bash
# 1. Build Docker image
docker build -t comic-ocr-server:v1.0 .

# 2. Run container (port 8000)
docker run -d --name comic-ocr -p 8000:8000 --restart unless-stopped comic-ocr-server:v1.0

# 3. Check health
curl http://localhost:8000/health
```

### Local Algorithm Playground
* Double-click **`启动算法演练台.bat`** on Windows;
* Your browser will automatically open `http://127.0.0.1:9000/playground` for real-time visual parameter tweaking and contour inspection.

---

## 6. Project Directory Tree

```text
comic-ocr-server / comic-translate-mobile
├── android/                            # Android local edge OCR project (ComicOCR v1.0.3)
│   ├── app/src/main/cpp/               # C++20 NDK core (thresholding, ncnn JNI, clustering)
│   ├── app/src/main/java/              # Ktor CIO async server + Anti-Freeze keep-alive suite
│   └── app/src/main/assets/            # ncnn models and multi-lingual dictionaries
├── app/                                # Cloud Python FastAPI OCR microservice
│   ├── main.py                         # API endpoints and lifespan model warmup
│   ├── engine.py                       # RapidOCR engine manager and dynamic filtering
│   ├── styling.py                      # Border ring color extraction & font weight estimation
│   └── clustering.py                   # BFS bubble clustering & role assignment
├── plugin/                             # Web Extension source code (v1.0.4)
│   ├── manifest.json                   # Manifest V3 configuration with logo icons
│   ├── icons/                          # Multi-resolution icon set (16/48/128px)
│   ├── popup.html / popup.css          # Cyber dark popup UI with live status indicator
│   ├── store.js                        # Multi-tier sensitivity presets & persistence
│   ├── floating-ball.js                # Floating control ball (gestures, routing, modal)
│   ├── capture.js                      # Slicing coordinator & PNA background relay
│   └── slicing/                        # Virtual strip & adaptive valley seam algorithm
├── ComicOCR-v1.0.3.apk                 # [Latest Release] Android application APK
├── comic-translate-plugin-v1.0.4.zip   # [Latest Release] Web Extension package
├── 启动算法演练台.bat                  # [Developer Tool] One-click offline playground launcher
├── Dockerfile                          # Cloud Docker container definition
├── README.md                           # Chinese Project Documentation
└── README.en.md                        # English Project Documentation
```

---

## 7. License & Acknowledgements

* **Core Pipeline**: MIT License
* **Inference Engines**: [Tencent ncnn (BSD-3-Clause)](https://github.com/Tencent/ncnn) / [RapidOCR (Apache-2.0)](https://github.com/RapidAI/RapidOCR)
* **LLM Engine**: [DeepSeek Open Platform](https://platform.deepseek.com/)
