package com.comic.ocr

import android.content.res.AssetManager
import android.graphics.Bitmap

object OcrNative {
    init {
        System.loadLibrary("comic_ocr")
    }

    external fun nativeInit(assetManager: AssetManager): Boolean

    external fun nativeProcessSlice(
        bitmap: Bitmap,
        lang: String,
        startY: Int,
        sliceIndex: Int,
        recThresh: Float = 0.70f,
        boxThresh: Float = 0.55f
    ): String
}
