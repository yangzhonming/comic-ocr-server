cmake_minimum_required(VERSION 3.22.1)
project("comic_ocr")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(ROOT_PROJECT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../..")

# 1. OpenCV-Mobile
set(OpenCV_DIR "${ROOT_PROJECT_DIR}/tools/opencv-mobile-android/opencv-mobile-4.10.0-android/sdk/native/jni")
find_package(OpenCV REQUIRED)

# 2. Tencent ncnn (Vulkan GPU enabled)
set(ncnn_DIR "${ROOT_PROJECT_DIR}/tools/ncnn-android-vulkan/ncnn-20260526-android-vulkan/${ANDROID_ABI}/lib/cmake/ncnn")
find_package(ncnn REQUIRED)
set_target_properties(ncnn PROPERTIES INTERFACE_COMPILE_OPTIONS "")

# 3. Source files
set(OCR_SOURCES
    clipper.cpp
    DBNetDetector.cpp
    CRNNRecognizer.cpp
    BubbleClustering.cpp
    ocr_jni.cpp
)

add_library(comic_ocr SHARED ${OCR_SOURCES})

target_include_directories(comic_ocr PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${OpenCV_INCLUDE_DIRS}
)

target_compile_options(comic_ocr PRIVATE
    -fexceptions
    -frtti
)

target_link_libraries(comic_ocr PRIVATE
    ncnn
    ${OpenCV_LIBS}
    vulkan
    jnigraphics
    android
    log
)
