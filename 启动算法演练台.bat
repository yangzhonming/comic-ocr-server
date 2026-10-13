@echo off
chcp 65001 >nul
title 漫画流式切片与 OCR 算法演练台 (Algorithm Playground)
setlocal

echo ================================================================
echo           漫画切片与 OCR 算法演练台 (Algorithm Playground)
echo ================================================================
echo 服务监听地址: http://127.0.0.1:9000
echo 页面访问入口: http://127.0.0.1:9000/playground
echo 特性: 动态探针调参、DET文本框/细线过滤/REC逐行多帧可视化对比
echo 正在启动本地服务并自动打开浏览器...
echo ================================================================
echo.

cd /d "%~dp0"

start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:9000/playground"

python tests/debug_inspect_server.py

pause
