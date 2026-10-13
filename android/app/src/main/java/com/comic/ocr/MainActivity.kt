package com.comic.ocr

import android.Manifest
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.view.animation.AccelerateDecelerateInterpolator
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : AppCompatActivity() {

    private lateinit var cardStatusBanner: MaterialCardView
    private lateinit var viewBeaconRing: View
    private lateinit var viewBeaconCore: View
    private lateinit var textStatusTitle: TextView
    private lateinit var textStatusUrl: TextView
    private lateinit var textPortBadge: TextView
    private lateinit var btnToggleService: MaterialButton
    private lateinit var textLatency: TextView
    private lateinit var textMemory: TextView
    private lateinit var textSlices: TextView
    private lateinit var textEngine: TextView
    private lateinit var textTerminalLive: TextView
    private lateinit var btnClearLogs: TextView
    private lateinit var scrollLogs: ScrollView
    private lateinit var textLogs: TextView
    private lateinit var textSocketStatus: TextView
    private lateinit var btnBatteryOpt: TextView

    private var beaconAnimator: AnimatorSet? = null
    private val timeFormat = SimpleDateFormat("HH:mm:ss.SSS", Locale.getDefault())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        initViews()
        requestPermissionsIfNeeded()

        if (!OcrHttpService.isRunning) {
            startOcrService()
        }

        setupListeners()
        observeServiceFlows()
        updateUiState()
    }

    private fun initViews() {
        cardStatusBanner = findViewById(R.id.card_status_banner)
        viewBeaconRing = findViewById(R.id.view_beacon_ring)
        viewBeaconCore = findViewById(R.id.view_beacon_core)
        textStatusTitle = findViewById(R.id.text_status_title)
        textStatusUrl = findViewById(R.id.text_status_url)
        textPortBadge = findViewById(R.id.text_port_badge)
        btnToggleService = findViewById(R.id.btn_toggle_service)
        textLatency = findViewById(R.id.text_latency)
        textMemory = findViewById(R.id.text_memory)
        textSlices = findViewById(R.id.text_slices)
        textEngine = findViewById(R.id.text_engine)
        textTerminalLive = findViewById(R.id.text_terminal_live)
        btnClearLogs = findViewById(R.id.btn_clear_logs)
        scrollLogs = findViewById(R.id.scroll_logs)
        textLogs = findViewById(R.id.text_logs)
        textSocketStatus = findViewById(R.id.text_socket_status)
        btnBatteryOpt = findViewById(R.id.btn_battery_opt)
    }

    private fun setupListeners() {
        btnToggleService.setOnClickListener {
            if (OcrHttpService.isRunning) {
                stopOcrService()
            } else {
                startOcrService()
            }
        }

        btnClearLogs.setOnClickListener {
            textLogs.text = "// Logs cleared by user\n"
        }

        btnBatteryOpt.setOnClickListener {
            requestIgnoreBatteryOptimizations()
        }
    }

    private fun observeServiceFlows() {
        // Collect real-time log stream
        lifecycleScope.launch {
            OcrHttpService.logFlow.collectLatest { logLine ->
                runOnUiThread {
                    val now = timeFormat.format(Date())
                    textLogs.append("[$now] $logLine\n")
                    scrollLogs.post {
                        scrollLogs.fullScroll(View.FOCUS_DOWN)
                    }
                }
            }
        }

        // Collect background service running state
        lifecycleScope.launch {
            OcrHttpService.isRunningFlow.collectLatest {
                runOnUiThread {
                    updateUiState()
                }
            }
        }

        // Collect hardware and slice telemetry stats
        lifecycleScope.launch {
            OcrHttpService.statsFlow.collectLatest { stats ->
                runOnUiThread {
                    if (OcrHttpService.isRunning) {
                        if (stats.lastLatencyMs > 0) {
                            textLatency.text = "${stats.lastLatencyMs} ms"
                        }
                        if (stats.memoryUsageMb > 0) {
                            textMemory.text = "${stats.memoryUsageMb} MB"
                        }
                        textSlices.text = "${stats.totalSlices} 片"
                    }
                }
            }
        }
    }

    private fun startBeaconAnimation() {
        if (beaconAnimator != null) return
        viewBeaconRing.visibility = View.VISIBLE

        val scaleX = ObjectAnimator.ofFloat(viewBeaconRing, "scaleX", 0.8f, 1.9f)
        val scaleY = ObjectAnimator.ofFloat(viewBeaconRing, "scaleY", 0.8f, 1.9f)
        val alpha = ObjectAnimator.ofFloat(viewBeaconRing, "alpha", 0.85f, 0.0f)

        scaleX.repeatCount = ValueAnimator.INFINITE
        scaleY.repeatCount = ValueAnimator.INFINITE
        alpha.repeatCount = ValueAnimator.INFINITE

        beaconAnimator = AnimatorSet().apply {
            playTogether(scaleX, scaleY, alpha)
            duration = 1800
            interpolator = AccelerateDecelerateInterpolator()
            start()
        }
    }

    private fun stopBeaconAnimation() {
        beaconAnimator?.cancel()
        beaconAnimator = null
        viewBeaconRing.visibility = View.INVISIBLE
        viewBeaconRing.scaleX = 1.0f
        viewBeaconRing.scaleY = 1.0f
        viewBeaconRing.alpha = 1.0f
    }

    private fun updateUiState() {
        val running = OcrHttpService.isRunning

        if (running) {
            // === 存活运行中 (绿色常闪呼吸心跳) ===
            startBeaconAnimation()
            viewBeaconCore.setBackgroundResource(R.drawable.dot_green)

            textStatusTitle.text = "ONLINE (存活运行中)"
            textStatusTitle.setTextColor(ContextCompat.getColor(this, R.color.status_green))

            textStatusUrl.text = "http://127.0.0.1:8080 (回环)"
            textPortBadge.text = ":8080 OK"
            textPortBadge.setTextColor(ContextCompat.getColor(this, R.color.status_green))

            textTerminalLive.text = "● LIVE"
            textTerminalLive.setTextColor(ContextCompat.getColor(this, R.color.status_green))

            textSocketStatus.text = "Ktor Socket: Active (Port 8080)"

            // Shorter centered action button -> Red "STOP SERVICE"
            btnToggleService.text = "⏹  STOP SERVICE"
            btnToggleService.backgroundTintList = ColorStateList.valueOf(
                ContextCompat.getColor(this, R.color.status_red_dark)
            )

            textEngine.text = "Vulkan ncnn"
        } else {
            // === 服务已停止 (绿灯熄灭，波纹停止，变成红点沉寂) ===
            stopBeaconAnimation()
            viewBeaconCore.setBackgroundResource(R.drawable.dot_red)

            textStatusTitle.text = "OFFLINE (服务已关闭)"
            textStatusTitle.setTextColor(ContextCompat.getColor(this, R.color.status_red))

            textStatusUrl.text = "服务未启动 (端口 8080 离线)"
            textPortBadge.text = ":8080 CLOSED"
            textPortBadge.setTextColor(ContextCompat.getColor(this, R.color.text_muted))

            textTerminalLive.text = "○ OFFLINE"
            textTerminalLive.setTextColor(ContextCompat.getColor(this, R.color.status_red))

            textSocketStatus.text = "Ktor Socket: Closed"

            // Shorter centered action button -> Cyber Violet "START SERVICE"
            btnToggleService.text = "▶  START SERVICE"
            btnToggleService.backgroundTintList = ColorStateList.valueOf(
                ContextCompat.getColor(this, R.color.cyber_violet)
            )

            textLatency.text = "--"
            textEngine.text = "Standby"
        }
    }

    private fun requestPermissionsIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 101)
            }
        }
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
            requestIgnoreBatteryOptimizations()
        }
    }

    @SuppressLint("BatteryLife")
    private fun requestIgnoreBatteryOptimizations() {
        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!powerManager.isIgnoringBatteryOptimizations(packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
            startActivity(intent)
        } else {
            Toast.makeText(this, "已获取电池无限制保活权限！", Toast.LENGTH_SHORT).show()
        }
    }

    private fun startOcrService() {
        val intent = Intent(this, OcrHttpService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        updateUiState()
    }

    private fun stopOcrService() {
        val intent = Intent(this, OcrHttpService::class.java)
        stopService(intent)
        updateUiState()
    }

    override fun onResume() {
        super.onResume()
        updateUiState()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopBeaconAnimation()
    }
}
