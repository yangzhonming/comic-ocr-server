---
title: Comic OCR Server
emoji: 📖
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Comic OCR Server

轻量级、无状态、面向 Serverless / PaaS 极致优化的漫画 OCR 及文本样式提取微服务。

- **DET**: PP-OCRv4 (1024 Receptive Field, Passes=1)
- **REC**: PP-OCRv5 Multi-Language Router (KR, EN, JP, RU, ZH)
- **Styling**: Dual-Sampling Background & Foreground Color Extraction
- **Clustering**: BFS Graph Connected-Component Clustering with Anti-SFX Shield
- **API**: `POST /api/v1/slice`
