package com.comic.ocr

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import android.util.Log
import android.util.Base64
import android.os.PowerManager
import android.net.wifi.WifiManager
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.PartData
import io.ktor.http.content.forEachPart
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.engine.embeddedServer
import io.ktor.server.plugins.cors.routing.CORS
import io.ktor.server.request.receiveMultipart
import io.ktor.server.request.receiveText
import io.ktor.server.response.respondText
import io.ktor.utils.io.core.readBytes
import io.ktor.utils.io.jvm.javaio.toInputStream
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.options
import io.ktor.server.routing.routing
import io.ktor.server.response.header
import io.ktor.server.response.respond
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.ByteArrayOutputStream

data class ServiceStats(
    val totalSlices: Int = 0,
    val lastLatencyMs: Long = 0,
    val memoryUsageMb: Long = 0
)

class OcrHttpService : Service() {

    companion object {
        private const val TAG = "OcrHttpService"
        const val CHANNEL_ID = "comic_ocr_channel"
        const val NOTIFICATION_ID = 1001

        private val _logFlow = MutableSharedFlow<String>(extraBufferCapacity = 64)
        val logFlow = _logFlow.asSharedFlow()

        private val _isRunningFlow = kotlinx.coroutines.flow.MutableStateFlow(false)
        val isRunningFlow = _isRunningFlow.asStateFlow()

        private var sliceCounter = 0
        private val _statsFlow = kotlinx.coroutines.flow.MutableStateFlow(ServiceStats())
        val statsFlow = _statsFlow.asStateFlow()

        var isRunning: Boolean
            get() = _isRunningFlow.value
            private set(value) {
                _isRunningFlow.value = value
            }
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var server: ApplicationEngine? = null

    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private fun acquireLocks() {
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (wakeLock == null) {
                wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ComicOCR:BackgroundWakeLock").apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            if (wifiLock == null) {
                @Suppress("DEPRECATION")
                wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "ComicOCR:BackgroundWifiLock").apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }
            _logFlow.tryEmit("[POWER] PartialWakeLock & WifiHighPerfLock acquired (Permanent Anti-Freeze active)")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire power/wifi locks", e)
        }
    }

    private fun releaseLocks() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
            wakeLock = null
            wifiLock?.let { if (it.isHeld) it.release() }
            wifiLock = null
            _logFlow.tryEmit("[POWER] WakeLock & WifiLock released")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to release locks", e)
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        acquireLocks()

        if (server == null) {
            startKtorServer()
        }

        return START_STICKY
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Comic OCR Background Engine",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Keeps the local ncnn OCR server running on port 8080"
                setSound(null, null)
                enableVibration(false)
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    private fun startAsForeground() {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        val notification: Notification = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Comic OCR Engine Active")
                .setContentText("Listening on port 8080 (Adreno Vulkan GPU)")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setContentTitle("Comic OCR Engine Active")
                .setContentText("Listening on port 8080")
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .build()
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        isRunning = true
    }

    private fun startKtorServer() {
        serviceScope.launch {
            try {
                // Initialize Native Models from Assets
                _logFlow.emit("[INIT] Loading ncnn models into Adreno GPU...")
                val initSuccess = OcrNative.nativeInit(assets)
                if (!initSuccess) {
                    _logFlow.emit("[ERROR] Native model initialization failed!")
                    return@launch
                }
                _logFlow.emit("[OK] Native models loaded! Starting Ktor server :8080")
                val runtime = Runtime.getRuntime()
                val usedMem = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024)
                _statsFlow.value = ServiceStats(totalSlices = sliceCounter, lastLatencyMs = 0, memoryUsageMb = usedMem)

                server = embeddedServer(CIO, port = 8080) {
                    install(CORS) {
                        anyHost()
                        allowHeader(HttpHeaders.ContentType)
                        allowHeader(HttpHeaders.Authorization)
                        allowHeader("Access-Control-Request-Private-Network")
                        allowHeader("access-control-request-private-network")
                        allowMethod(HttpMethod.Options)
                        allowMethod(HttpMethod.Get)
                        allowMethod(HttpMethod.Post)
                        allowNonSimpleContentTypes = true
                    }

                    routing {
                        options("{...}") {
                            call.response.header("Access-Control-Allow-Origin", "*")
                            call.response.header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
                            call.response.header("Access-Control-Allow-Headers", "*")
                            call.response.header("Access-Control-Allow-Private-Network", "true")
                            call.respond(HttpStatusCode.OK)
                        }

                        get("/") {
                            call.response.header("Access-Control-Allow-Private-Network", "true")
                            call.respondText(
                                "{\"service\":\"comic-ocr-mobile\",\"status\":\"running\"}",
                                ContentType.Application.Json
                            )
                        }

                        get("/health") {
                            call.response.header("Access-Control-Allow-Private-Network", "true")
                            call.respondText(
                                "{\"status\":\"ok\",\"version\":\"1.0.0\",\"device\":\"vulkan\",\"loaded_models\":[\"korean\",\"en\",\"japan\",\"cyrillic\"]}",
                                ContentType.Application.Json
                            )
                        }

                        post("/coordinates") {
                            call.response.header("Access-Control-Allow-Private-Network", "true")
                            call.respondText(
                                "{\"code\":0,\"message\":\"coordinates registered\"}",
                                ContentType.Application.Json
                            )
                        }

                        // Compatible with Chrome Extension /slice (multipart/form-data)
                        post("/slice") {
                            val multipart = call.receiveMultipart()
                            var fileBytes: ByteArray? = null
                            var sliceIndex = 0
                            var startY = 0
                            var lang = "korean"
                            var recThresh = 0.70f
                            var boxThresh = 0.55f

                            multipart.forEachPart { part ->
                                when (part) {
                                    is PartData.FileItem -> {
                                        fileBytes = part.provider().readBytes()
                                    }
                                    is PartData.FormItem -> {
                                        when (part.name) {
                                            "slice_index" -> sliceIndex = part.value.toIntOrNull() ?: 0
                                            "start_y" -> startY = part.value.toIntOrNull() ?: 0
                                            "lang" -> lang = part.value
                                            "rec_thresh" -> recThresh = part.value.toFloatOrNull() ?: 0.70f
                                            "box_thresh" -> boxThresh = part.value.toFloatOrNull() ?: 0.55f
                                        }
                                    }
                                    else -> {}
                                }
                                part.dispose()
                            }

                            if (fileBytes == null || fileBytes!!.isEmpty()) {
                                call.respondText(
                                    "{\"code\":400,\"message\":\"No file uploaded\"}",
                                    ContentType.Application.Json,
                                    HttpStatusCode.BadRequest
                                )
                                return@post
                            }

                            val t0 = System.currentTimeMillis()
                            val bitmap = BitmapFactory.decodeByteArray(fileBytes, 0, fileBytes!!.size)
                            if (bitmap == null) {
                                call.respondText(
                                    "{\"code\":400,\"message\":\"Invalid image format\"}",
                                    ContentType.Application.Json,
                                    HttpStatusCode.BadRequest
                                )
                                return@post
                            }

                            val jsonResult = OcrNative.nativeProcessSlice(bitmap, lang, startY, sliceIndex, recThresh, boxThresh)
                            val cost = System.currentTimeMillis() - t0

                            val runtime = Runtime.getRuntime()
                            val usedMem = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024)
                            sliceCounter++
                            _statsFlow.value = ServiceStats(
                                totalSlices = sliceCounter,
                                lastLatencyMs = cost,
                                memoryUsageMb = usedMem
                            )

                            _logFlow.emit("[Slice #$sliceIndex] processed in ${cost}ms (lang=$lang, recThresh=$recThresh, boxThresh=$boxThresh)")
                            call.response.header("Access-Control-Allow-Private-Network", "true")
                            call.respondText(jsonResult, ContentType.Application.Json)
                        }

                        // Compatible with Blueprint /api/ocr (JSON base64)
                        post("/api/ocr") {
                            val text = call.receiveText()
                            val json = JSONObject(text)
                            var base64Data = json.optString("image", "")
                            val lang = json.optString("language", "korean")
                            val recThresh = json.optDouble("rec_thresh", 0.70).toFloat()
                            val boxThresh = json.optDouble("box_thresh", 0.55).toFloat()

                            if (base64Data.contains(",")) {
                                base64Data = base64Data.substringAfter(",")
                            }

                            val rawBytes = Base64.decode(base64Data, Base64.DEFAULT)
                            val bitmap = BitmapFactory.decodeByteArray(rawBytes, 0, rawBytes.size)

                            if (bitmap == null) {
                                call.respondText(
                                    "{\"code\":400,\"msg\":\"Failed to decode base64 image\"}",
                                    ContentType.Application.Json,
                                    HttpStatusCode.BadRequest
                                )
                                return@post
                            }

                            val t0 = System.currentTimeMillis()
                            val jsonResult = OcrNative.nativeProcessSlice(bitmap, lang, 0, 0, recThresh, boxThresh)
                            val cost = System.currentTimeMillis() - t0

                            val runtime = Runtime.getRuntime()
                            val usedMem = (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024)
                            sliceCounter++
                            _statsFlow.value = ServiceStats(
                                totalSlices = sliceCounter,
                                lastLatencyMs = cost,
                                memoryUsageMb = usedMem
                            )

                            _logFlow.emit("[API /ocr] processed in ${cost}ms (lang=$lang)")
                            call.response.header("Access-Control-Allow-Private-Network", "true")
                            call.respondText(jsonResult, ContentType.Application.Json)
                        }
                    }
                }.start(wait = true)

            } catch (e: Exception) {
                Log.e(TAG, "Error in Ktor server", e)
                _logFlow.emit("[FATAL] Server error: ${e.message}")
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        releaseLocks()
        isRunning = false
        _statsFlow.value = ServiceStats(0, 0, 0)
        try {
            server?.stop(500, 1000)
        } catch (_: Exception) {}
        server = null
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
