// ==========================================================================
// SMART ROLLER BLIND IoT PRO - CORE JAVASCRIPT ENGINE (2 SEPARATE CHARTS)
// ==========================================================================

// ==================== FIREBASE CONFIGURATION ====================
const firebaseConfig = {
    apiKey: "AIzaSyB0uVd7K3G2mo4bmv0U_TIeQiUtzyhcwnk",
    authDomain: "jemuran-iot-56180.firebaseapp.com",
    databaseURL: "https://jemuran-iot-56180-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "jemuran-iot-56180",
    storageBucket: "jemuran-iot-56180.firebasestorage.app",
    messagingSenderId: "631924407234",
    appId: "1:631924407234:web:4a6854840dcb2e2fd8345b",
    measurementId: "G-KE3P5EHL3S"
};

let db = null;
let isFirebaseReady = false;

// ==================== MQTT CONFIGURATION ====================
const MQTT_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const TOPIC_STATUS = 'jemuran/status';
const TOPIC_CONTROL = 'jemuran/control';
const TOPIC_MODE = 'jemuran/mode';

let mqttClient = null;
let clientId = 'ESP32_ProDash_' + Math.random().toString(16).substr(2, 8);

// ==================== GLOBAL STATE ====================
let currentMode = 'auto';
let blindPositionPercent = 100;

let latestData = {
    temp: 26.1,
    hum: 76,
    rain1: 0,
    rain2: 0,
    wind: 18,
    isRaining: false,
    blindStatus: 'open',
    mode: 'auto'
};

let fullSensorHistory = [];
let selectedDateFilter = 'today'; // 'today', 'all', atau 'YYYY-MM-DD'
let lastChartPushTime = 0;

function getTodayDateString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getTimestampFromFirebaseKey(key) {
    if (!key || typeof key !== 'string' || key.length < 8) return null;
    const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
    let time = 0;
    for (let i = 0; i < 8; i++) {
        const c = key.charAt(i);
        const idx = PUSH_CHARS.indexOf(c);
        if (idx === -1) return null;
        time = time * 64 + idx;
    }
    return time;
}

function parseSensorRecord(item, key) {
    let ts = item.timestamp;
    if (!ts && key) {
        ts = getTimestampFromFirebaseKey(key);
    }
    if (!ts) ts = Date.now();

    let date = item.date;
    if (!date && ts) {
        const d = new Date(ts);
        date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    if (!date) date = getTodayDateString();

    let time = item.time;
    if (!time && ts) {
        time = new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    return {
        date: date,
        time: time || '00:00:00',
        timestamp: ts,
        temp: Number(item.temp || 0),
        hum: Number(item.hum || 0),
        rain1: Number(item.rain1 || 0),
        rain2: Number(item.rain2 || 0),
        fuzzyScore: item.fuzzyScore !== undefined ? Number(item.fuzzyScore) : null,
        blindStatus: item.blindStatus || 'open'
    };
}

let logs = [];
let dhtChart = null;
let rainChart = null;

// Canvas Particles
let canvas, ctx;
let windLines = [];
let flyingLeaves = [];
let raindrops = [];
let animationFrame;

// City Coordinates for Open-Meteo
const CITY_COORDINATES = {
    jakarta: { name: 'Jakarta', lat: -6.2088, lon: 106.8456 },
    bandung: { name: 'Bandung', lat: -6.9175, lon: 107.6191 },
    surabaya: { name: 'Surabaya', lat: -7.2575, lon: 112.7521 },
    yogyakarta: { name: 'Yogyakarta', lat: -7.7956, lon: 110.3695 },
    semarang: { name: 'Semarang', lat: -6.9667, lon: 110.4167 },
    medan: { name: 'Medan', lat: 3.5952, lon: 98.6722 },
    makassar: { name: 'Makassar', lat: -5.1477, lon: 119.4327 },
    denpasar: { name: 'Bali / Denpasar', lat: -8.6705, lon: 115.2126 },
    jayapura: { name: 'Jayapura', lat: -2.5337, lon: 140.7181 }
};

// ==================== INITIALIZATION ====================
window.addEventListener('load', () => {
    updateSystemClock();
    setInterval(updateSystemClock, 1000);

    fetchLocationWeather('auto');

    setTimeout(() => {
        initHeroCanvas();
    }, 150);

    initSeparateCharts();
    initFirebase();
    connectMQTT();

    // Trigger initial render
    updateDashboard(latestData, false);

    // Set nilai awal date picker ke hari ini
    const picker = document.getElementById('sensorDatePicker');
    if (picker) picker.value = getTodayDateString();

    addLog('info', 'SmartJemur PRO UI with separated charts initialized');
    
    // Mulai watchdog deteksi hardware offline setiap 3 detik
    setInterval(checkHardwareStatus, 3000);
});

// ==================== WATCHDOG HARDWARE STATUS ====================
let lastHardwareHeartbeat = 0;
let isHardwareOnline = false;

function onHardwareHeartbeat() {
    lastHardwareHeartbeat = Date.now();
    if (!isHardwareOnline) {
        isHardwareOnline = true;
        const pulseDot = document.getElementById('systemPulseDot');
        const cloudText = document.getElementById('systemCloudText');
        if (pulseDot) {
            pulseDot.style.background = '#10B981';
            pulseDot.style.boxShadow = '0 0 10px #10B981';
        }
        if (cloudText) cloudText.textContent = 'ESP32 Online';
        addLog('info', 'Hardware ESP32 terhubung (Online)');
    }
}

function checkHardwareStatus() {
    const now = Date.now();
    // Jika tidak ada data dari hardware selama > 15 detik
    if (lastHardwareHeartbeat > 0 && (now - lastHardwareHeartbeat > 15000)) {
        if (isHardwareOnline) {
            isHardwareOnline = false;
            const pulseDot = document.getElementById('systemPulseDot');
            const cloudText = document.getElementById('systemCloudText');
            if (pulseDot) {
                pulseDot.style.background = '#F43F5E';
                pulseDot.style.boxShadow = '0 0 10px #F43F5E';
            }
            if (cloudText) cloudText.textContent = 'ESP32 Offline';
            addLog('warn', 'Hardware ESP32 terputus / mati (>15 detik tanpa data)');
        }
    }
}


// ==================== CLOCK ====================
function updateSystemClock() {
    const now = new Date();
    const clockEl = document.getElementById('systemLiveClock');
    const timeShortEl = document.getElementById('liveTimeShort');
    
    if (clockEl) {
        const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
        
        const dayName = days[now.getDay()];
        const date = now.getDate();
        const monthName = months[now.getMonth()];
        const year = now.getFullYear();
        
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const seconds = String(now.getSeconds()).padStart(2, '0');

        clockEl.textContent = `${dayName}, ${date} ${monthName} ${year} • ${hours}:${minutes}:${seconds}`;
        if (timeShortEl) timeShortEl.textContent = `${hours}:${minutes}:${seconds}`;
    }
}

// ==================== NAVIGATION ====================
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.toggle('open');
}

function switchNavTab(tabId) {
    // Desktop sidebar active sync
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
        item.classList.remove('active');
        const text = item.textContent.toLowerCase();
        if (text.includes(tabId)) item.classList.add('active');
    });

    // Mobile bottom nav active sync
    document.querySelectorAll('.mobile-bottom-nav .mob-nav-item').forEach(item => {
        item.classList.remove('active');
        const text = item.textContent.toLowerCase();
        if (text.includes(tabId)) item.classList.add('active');
    });

    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    const targetPane = document.getElementById(`tab-${tabId}`);
    if (targetPane) targetPane.classList.add('active');

    const titles = {
        overview: '☀️ Dashboard Overview',
        analytics: '📈 Master Telemetry Analytics',
        control: '🎛️ Motor Control Center',
        logs: '📝 Activity & Telemetry Logs'
    };
    const titleEl = document.getElementById('pageHeadingTitle');
    if (titleEl && titles[tabId]) titleEl.textContent = titles[tabId];

    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 950) {
        sidebar.classList.remove('open');
    }

    if (tabId === 'analytics') {
        setTimeout(() => {
            if (dhtChart) dhtChart.resize();
            if (rainChart) rainChart.resize();
        }, 100);
    }
}

// ==================== LOCATION & OPEN-METEO ====================
async function onLocationChange() {
    const select = document.getElementById('citySelect');
    if (!select) return;
    await fetchLocationWeather(select.value);
}

async function fetchLocationWeather(cityKey) {
    let lat = -6.2088;
    let lon = 106.8456;

    if (cityKey === 'auto') {
        if ("geolocation" in navigator) {
            navigator.geolocation.getCurrentPosition(
                pos => queryOpenMeteo(pos.coords.latitude, pos.coords.longitude),
                err => queryOpenMeteo(-6.2088, 106.8456),
                { timeout: 4000 }
            );
            return;
        }
    } else if (CITY_COORDINATES[cityKey]) {
        lat = CITY_COORDINATES[cityKey].lat;
        lon = CITY_COORDINATES[cityKey].lon;
    }

    queryOpenMeteo(lat, lon);
}

async function queryOpenMeteo(lat, lon) {
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
        const res = await fetch(url);
        const data = await res.json();

        if (data && data.current) {
            const temp = data.current.temperature_2m;
            const hum = data.current.relative_humidity_2m;
            const wind = Math.round(data.current.wind_speed_10m || 18);
            const wCode = data.current.weather_code;
            
            let isRain = (wCode >= 51 && wCode <= 99);

            const tempTag = document.getElementById('heroTempTag');
            const humTag = document.getElementById('heroHumTag');
            const condTag = document.getElementById('heroConditionTag');
            const windVal = document.getElementById('valWind');

            if (tempTag) tempTag.textContent = `🌡️ ${temp}°C`;
            if (humTag) humTag.textContent = `💧 ${hum}%`;
            if (condTag) condTag.textContent = isRain ? '🌧️ Hujan' : '☀️ Cerah';
            if (windVal) windVal.innerHTML = `${wind} <span style="font-size: 0.9rem; font-weight: 500; color: var(--text-muted);">km/h</span>`;

            latestData.wind = wind;
            updateHeroBackground(isRain);
        }
    } catch (e) {
        console.warn('Open-Meteo fallback');
    }
}

// ==================== HERO BACKGROUND CONTROLLER ====================
function updateHeroBackground(isRain) {
    const bgNight = document.getElementById('bgNight');
    const bgDay = document.getElementById('bgDay');
    const bgRain = document.getElementById('bgRain');

    const hour = new Date().getHours();
    const isDay = hour >= 6 && hour < 18;

    if (isRain) {
        if (bgRain) bgRain.style.opacity = '1';
        if (bgDay) bgDay.style.opacity = '0';
        if (bgNight) bgNight.style.opacity = '0';
    } else if (isDay) {
        if (bgRain) bgRain.style.opacity = '0';
        if (bgDay) bgDay.style.opacity = '1';
        if (bgNight) bgNight.style.opacity = '0';
    } else {
        if (bgRain) bgRain.style.opacity = '0';
        if (bgDay) bgDay.style.opacity = '0';
        if (bgNight) bgNight.style.opacity = '1';
    }
}

// ==================== UPDATE DASHBOARD TELEMETRY ====================
function updateDashboard(data, syncToCloud = false) {
    if (!data) return;
    latestData = { ...latestData, ...data };

    const temp = Number(data.temp !== undefined ? data.temp : 26.1);
    const hum = Number(data.hum !== undefined ? data.hum : 76);
    const rain1 = Number(data.rain1 || 0);
    const rain2 = Number(data.rain2 || 0);
    const isRain = Boolean(data.isRaining || (rain1 > 30 || rain2 > 30));
    const isClosed = data.blindStatus === 'closed' || blindPositionPercent === 0;
    const mode = (data.mode || currentMode).toLowerCase();

    // 1. Suhu & Kelembaban (DHT22)
    const valTemp = document.getElementById('valTemp');
    const valHum = document.getElementById('valHum');
    if (valTemp) valTemp.innerHTML = `${temp.toFixed(1)}<span style="font-size: 1rem; font-weight: 500; color: var(--text-muted);">°C</span>`;
    if (valHum) valHum.innerHTML = `${Math.round(hum)}<span style="font-size: 1rem; font-weight: 500; color: var(--text-muted);">%</span>`;

    // 2. Dual Rain Sensors
    const valRain1 = document.getElementById('valRain1');
    const valRain2 = document.getElementById('valRain2');
    const statusRain1 = document.getElementById('statusRain1Text');
    const statusRain2 = document.getElementById('statusRain2Text');

    if (valRain1) valRain1.textContent = `${Math.round(rain1)}%`;
    if (valRain2) valRain2.textContent = `${Math.round(rain2)}%`;
    if (statusRain1) statusRain1.textContent = rain1 > 20 ? 'Terdeteksi air' : 'Tidak ada hujan';
    if (statusRain2) statusRain2.textContent = rain2 > 20 ? 'Terdeteksi air' : 'Aman';

    // 3. Condition Card & Fusion (Fuzzy Sugeno Integration)
    const condTitle = document.getElementById('conditionHeroTitle');
    const condSub = document.getElementById('conditionHeroSub');
    const condGlow = document.getElementById('conditionIconGlow');
    const weatherPill = document.getElementById('weatherPill');
    const fusionTitle = document.getElementById('fusionBadgeTitle');
    const fusionDesc = document.getElementById('fusionDescText');
    const fusionGauge = document.getElementById('fusionGaugeProg');
    const fuzzyScore = data.fuzzyScore !== undefined ? Number(data.fuzzyScore) : null;

    if (isRain) {
        if (condTitle) condTitle.textContent = 'Hujan Terdeteksi';
        if (condSub) condSub.textContent = 'Tirai menutup otomatis (Fuzzy Sugeno)';
        if (condGlow) condGlow.textContent = '🌧️';
        if (weatherPill) weatherPill.innerHTML = `<span>🌧️</span><span>Hujan</span>`;
        if (fusionTitle) {
            fusionTitle.textContent = fuzzyScore !== null ? `Waspada Hujan! (Fuzzy Z: ${fuzzyScore.toFixed(2)})` : 'Waspada Hujan!';
            fusionTitle.style.color = 'var(--rose)';
        }
        if (fusionDesc) fusionDesc.textContent = 'Sensor mendeteksi presipitasi air hujan. Logika Sugeno mengarahkan aktuator untuk menutup tirai segera.';
        if (fusionGauge) {
            fusionGauge.style.strokeDashoffset = '140';
            fusionGauge.style.stroke = 'var(--rose)';
        }
    } else if (hum > 85 && temp < 27) {
        if (condTitle) condTitle.textContent = 'Mendung (Potensi Hujan)';
        if (condSub) condSub.textContent = 'Kelembaban atmosfer tinggi';
        if (condGlow) condGlow.textContent = '☁️';
        if (weatherPill) weatherPill.innerHTML = `<span>☁️</span><span>Mendung</span>`;
        if (fusionTitle) {
            fusionTitle.textContent = fuzzyScore !== null ? `Mendung / Potensi Hujan (Z: ${fuzzyScore.toFixed(2)})` : 'Potensi Mendung';
            fusionTitle.style.color = 'var(--amber)';
        }
        if (fusionDesc) fusionDesc.textContent = 'Suhu rendah dan kelembaban atmosfer tinggi. Logika Fuzzy Sugeno siap mengamankan jemuran.';
        if (fusionGauge) {
            fusionGauge.style.strokeDashoffset = '90';
            fusionGauge.style.stroke = 'var(--amber)';
        }
    } else {
        if (condTitle) condTitle.textContent = 'Cerah (Optimal)';
        if (condSub) condSub.textContent = 'Cocok untuk menjemur pakaian';
        if (condGlow) condGlow.textContent = '☀️';
        if (weatherPill) weatherPill.innerHTML = `<span>☀️</span><span>Cerah (Optimal)</span>`;
        if (fusionTitle) {
            fusionTitle.textContent = fuzzyScore !== null ? `Optimal Menjemur (Fuzzy Z: ${fuzzyScore.toFixed(2)})` : 'Optimal untuk Menjemur';
            fusionTitle.style.color = 'var(--emerald)';
        }
        if (fusionDesc) fusionDesc.textContent = 'Kondisi lingkungan ideal. Output defuzzifikasi Sugeno menunjukkan kondisi sangat aman untuk menjemur.';
        if (fusionGauge) {
            fusionGauge.style.strokeDashoffset = '25';
            fusionGauge.style.stroke = 'var(--emerald)';
        }
    }

    // Update Heartbeat Status (Online)
    onHardwareHeartbeat();

    // 4. Actuator Progress Bar
    updateActuatorUI(isClosed ? 0 : 100);
    updateHeroBackground(isRain);

    // 5. Push Telemetry to Chart History (Anti-Duplicate Throttling & Auto-Scale)
    const now = Date.now();
    const todayStr = getTodayDateString();
    const timeStr = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // Cegah duplikasi data MQTT & Firebase (minimal jeda 3.5 detik atau titik pertama)
    if (now - lastChartPushTime >= 3500 || fullSensorHistory.length === 0) {
        lastChartPushTime = now;

        fullSensorHistory.push({
            date: todayStr,
            time: timeStr,
            timestamp: now,
            temp: Number(temp.toFixed(1)),
            hum: Math.round(hum),
            rain1: Math.round(rain1),
            rain2: Math.round(rain2),
            fuzzyScore: fuzzyScore !== null ? Number(fuzzyScore.toFixed(3)) : null,
            blindStatus: isClosed ? 'closed' : 'open'
        });

        // Simpan kapasitas besar (hingga 5000 record di memori browser)
        if (fullSensorHistory.length > 5000) {
            fullSensorHistory.shift();
        }

        updateSeparateCharts();
    }

    // 6. Dual Cloud Sync
    if (syncToCloud && isFirebaseReady && db) {
        db.ref('jemuran/status').set({
            temp,
            hum,
            rain1,
            rain2,
            blindStatus: isClosed ? 'closed' : 'open',
            fuzzyScore: fuzzyScore,
            isRaining: isRain,
            mode: mode,
            lastUpdate: Date.now()
        }).catch(err => {
            console.warn('Firebase status sync (check Firebase rules):', err.message);
        });

        db.ref('jemuran/history').push({
            date: todayStr,
            time: timeStr,
            timestamp: now,
            temp,
            hum,
            rain1,
            rain2,
            fuzzyScore: fuzzyScore,
            blindStatus: isClosed ? 'closed' : 'open'
        }).catch(err => {
            console.warn('Firebase history push (check Firebase rules):', err.message);
        });
    }
}

function updateActuatorUI(percent) {
    blindPositionPercent = percent;
    const statLabel = document.getElementById('actuatorStatusLabel');
    const percentLabel = document.getElementById('actuatorPercentLabel');
    const barFill = document.getElementById('actuatorBarFill');

    if (percent === 100) {
        if (statLabel) {
            statLabel.textContent = 'Terbuka Penuh';
            statLabel.style.color = 'var(--emerald)';
        }
        if (percentLabel) percentLabel.textContent = '100%';
        if (barFill) {
            barFill.style.width = '100%';
            barFill.style.background = 'linear-gradient(90deg, #10B981, #34D399)';
        }
    } else {
        if (statLabel) {
            statLabel.textContent = 'Tertutup Penuh';
            statLabel.style.color = 'var(--rose)';
        }
        if (percentLabel) percentLabel.textContent = '0%';
        if (barFill) {
            barFill.style.width = '0%';
            barFill.style.background = 'var(--rose)';
        }
    }
}

// ==================== 2 SEPARATE CHARTS (DHT22 & RAIN) ====================
function initSeparateCharts() {
    // 1. Chart DHT22 (Suhu & Kelembaban)
    const ctxDHT = document.getElementById('dhtTelemetryChart');
    if (ctxDHT) {
        dhtChart = new Chart(ctxDHT, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Suhu (°C)',
                        data: [],
                        borderColor: '#F43F5E',
                        backgroundColor: 'rgba(244, 63, 94, 0.08)',
                        borderWidth: 2.5,
                        fill: true,
                        tension: 0.35,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                        yAxisID: 'yTemp'
                    },
                    {
                        label: 'Kelembaban (%)',
                        data: [],
                        borderColor: '#0EA5E9',
                        backgroundColor: 'rgba(14, 165, 233, 0.08)',
                        borderWidth: 2.5,
                        borderDash: [5, 5],
                        fill: false,
                        tension: 0.35,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                        yAxisID: 'yHum'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(12, 18, 32, 0.95)',
                        titleColor: '#F8FAFC',
                        bodyColor: '#CBD5E1',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.04)' },
                        ticks: {
                            color: '#64748B',
                            font: { family: "'Plus Jakarta Sans', sans-serif", size: 11 },
                            autoSkip: true,
                            maxTicksLimit: 12,
                            maxRotation: 0
                        }
                    },
                    yTemp: {
                        type: 'linear',
                        position: 'left',
                        min: 0,
                        max: 50,
                        title: { display: true, text: 'Suhu Udara (°C)', color: '#F43F5E', font: { size: 11 } },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#F43F5E' }
                    },
                    yHum: {
                        type: 'linear',
                        position: 'right',
                        min: 0,
                        max: 100,
                        title: { display: true, text: 'Kelembaban Relatif RH (%)', color: '#0EA5E9', font: { size: 11 } },
                        grid: { drawOnChartArea: false },
                        ticks: { color: '#0EA5E9' }
                    }
                }
            }
        });
    }

    // 2. Chart Dual Sensor Hujan
    const ctxRain = document.getElementById('rainTelemetryChart');
    if (ctxRain) {
        rainChart = new Chart(ctxRain, {
            type: 'line',
            data: {
                labels: [],
                datasets: [
                    {
                        label: 'Sensor Hujan 1 (%)',
                        data: [],
                        borderColor: '#8B5CF6',
                        backgroundColor: 'rgba(139, 92, 246, 0.12)',
                        borderWidth: 2.5,
                        fill: true,
                        tension: 0.35,
                        pointRadius: 3,
                        pointHoverRadius: 6
                    },
                    {
                        label: 'Sensor Hujan 2 (%)',
                        data: [],
                        borderColor: '#10B981',
                        backgroundColor: 'rgba(16, 185, 129, 0.12)',
                        borderWidth: 2.5,
                        fill: true,
                        tension: 0.35,
                        pointRadius: 3,
                        pointHoverRadius: 6
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(12, 18, 32, 0.95)',
                        titleColor: '#F8FAFC',
                        bodyColor: '#CBD5E1',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.04)' },
                        ticks: {
                            color: '#64748B',
                            font: { family: "'Plus Jakarta Sans', sans-serif", size: 11 },
                            autoSkip: true,
                            maxTicksLimit: 12,
                            maxRotation: 0
                        }
                    },
                    y: {
                        type: 'linear',
                        min: 0,
                        max: 100,
                        title: { display: true, text: 'Intensitas Air / Kebasahan Plat (%)', color: '#94A3B8', font: { size: 11 } },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#94A3B8' }
                    }
                }
            }
        });
    }
}

function getFilteredSensorData() {
    if (!fullSensorHistory || fullSensorHistory.length === 0) return [];
    
    if (selectedDateFilter === 'all') {
        return fullSensorHistory;
    }
    
    const targetDate = (selectedDateFilter === 'today') ? getTodayDateString() : selectedDateFilter;
    return fullSensorHistory.filter(item => item.date === targetDate);
}

function updateSeparateCharts() {
    const filteredData = getFilteredSensorData();
    const timestamps = filteredData.map(d => {
        if (selectedDateFilter === 'all') {
            const parts = (d.date || '').split('-');
            const shortDate = parts.length === 3 ? `${parts[2]}/${parts[1]}` : d.date;
            return `${shortDate} ${d.time}`;
        }
        return d.time;
    });

    const temps = filteredData.map(d => d.temp);
    const hums = filteredData.map(d => d.hum);
    const rain1s = filteredData.map(d => d.rain1);
    const rain2s = filteredData.map(d => d.rain2);

    // Dynamic radius: jika data banyak (>60 titik), sembunyikan bulatan titik agar kurva halus tanpa padat visual
    const dynamicRadius = filteredData.length > 60 ? 0 : 2.5;

    if (dhtChart) {
        dhtChart.data.labels = timestamps;
        dhtChart.data.datasets[0].data = temps;
        dhtChart.data.datasets[0].pointRadius = dynamicRadius;
        dhtChart.data.datasets[1].data = hums;
        dhtChart.data.datasets[1].pointRadius = dynamicRadius;
        dhtChart.update('none');
    }

    if (rainChart) {
        rainChart.data.labels = timestamps;
        rainChart.data.datasets[0].data = rain1s;
        rainChart.data.datasets[0].pointRadius = dynamicRadius;
        rainChart.data.datasets[1].data = rain2s;
        rainChart.data.datasets[1].pointRadius = dynamicRadius;
        rainChart.update('none');
    }

    const infoEl = document.getElementById('chartDataCountInfo');
    if (infoEl) {
        const dateLabel = (selectedDateFilter === 'all') ? 'Semua Tanggal' : 
                          (selectedDateFilter === 'today' || selectedDateFilter === getTodayDateString()) ? `Hari Ini (${getTodayDateString()})` : selectedDateFilter;
        infoEl.textContent = `Menampilkan ${filteredData.length} data sensor (${dateLabel}) • Total Cloud: ${fullSensorHistory.length} data`;
    }
}

function onDateFilterChange(dateVal) {
    if (!dateVal) {
        filterByAllDates();
        return;
    }
    selectedDateFilter = dateVal;
    
    const btnToday = document.getElementById('btnDateToday');
    const btnAll = document.getElementById('btnDateAll');
    if (btnToday) btnToday.classList.toggle('active', dateVal === getTodayDateString());
    if (btnAll) btnAll.classList.remove('active');

    updateSeparateCharts();
    addLog('info', `Filter data sensor diubah ke tanggal: ${dateVal}`);
}

function filterByToday() {
    selectedDateFilter = getTodayDateString();
    const picker = document.getElementById('sensorDatePicker');
    if (picker) picker.value = selectedDateFilter;

    const btnToday = document.getElementById('btnDateToday');
    const btnAll = document.getElementById('btnDateAll');
    if (btnToday) btnToday.classList.add('active');
    if (btnAll) btnAll.classList.remove('active');

    updateSeparateCharts();
    addLog('info', 'Filter data sensor diatur ke: Hari Ini');
}

function filterByAllDates() {
    selectedDateFilter = 'all';
    const picker = document.getElementById('sensorDatePicker');
    if (picker) picker.value = '';

    const btnToday = document.getElementById('btnDateToday');
    const btnAll = document.getElementById('btnDateAll');
    if (btnToday) btnToday.classList.remove('active');
    if (btnAll) btnAll.classList.add('active');

    updateSeparateCharts();
    addLog('info', 'Filter data sensor diatur ke: Semua Tanggal (Tanpa Batas)');
}

function reloadFromFirebase() {
    if (!db) {
        alert('Firebase belum terhubung');
        return;
    }
    addLog('info', 'Memuat ulang seluruh histori data dari Firebase Cloud...');
    db.ref('jemuran/history').limitToLast(2000).once('value', (snapshot) => {
        const historyData = snapshot.val();
        if (historyData) {
            fullSensorHistory = [];
            Object.entries(historyData).forEach(([key, item]) => {
                fullSensorHistory.push(parseSensorRecord(item, key));
            });
            updateSeparateCharts();
            addLog('info', `Berhasil memuat ${fullSensorHistory.length} histori data dari Cloud`);
        } else {
            addLog('warn', 'Belum ada data histori di Firebase');
        }
    });
}

function exportSensorExcel() {
    const dataToExport = getFilteredSensorData();
    if (dataToExport.length === 0) {
        alert('Tidak ada data sensor pada tanggal yang dipilih untuk diekspor!');
        return;
    }

    const filterTag = selectedDateFilter === 'all' ? 'Semua_Tanggal' : selectedDateFilter;
    const exportTimeStr = new Date().toLocaleString('id-ID');

    let tableHtml = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
    <meta http-equiv="content-type" content="application/vnd.ms-excel; charset=UTF-8"/>
    <!--[if gte mso 9]>
    <xml>
      <x:ExcelWorkbook>
        <x:ExcelWorksheets>
          <x:ExcelWorksheet>
            <x:Name>Data Sensor Jemuran</x:Name>
            <x:WorksheetOptions>
              <x:DisplayGridlines/>
            </x:WorksheetOptions>
          </x:ExcelWorksheet>
        </x:ExcelWorksheets>
      </x:ExcelWorkbook>
    </xml>
    <![endif]-->
    <style>
      body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; }
      table { border-collapse: collapse; width: 100%; }
      .title-banner { background-color: #0F172A; color: #38BDF8; font-size: 13pt; font-weight: bold; text-align: center; padding: 10px; border: 1px solid #0F172A; }
      .meta-info { background-color: #F1F5F9; color: #475569; font-size: 9pt; text-align: center; padding: 6px; border: 1px solid #CBD5E1; }
      th { font-size: 10pt; font-weight: bold; text-align: center; padding: 8px 12px; border: 1px solid #000000; vertical-align: middle; }
      .text-cell { mso-number-format:"\\@"; text-align: center; }
      .num-temp { text-align: right; mso-number-format:"0\\.0"; }
      .num-fz { text-align: right; mso-number-format:"0\\.000"; }
      .num-int { text-align: right; mso-number-format:"0"; }
      .row-alt { background-color: #F8FAFC; }
      .status-open { color: #047857; font-weight: bold; background-color: #ECFDF5; text-align: center; }
      .status-closed { color: #BE123C; font-weight: bold; background-color: #FFF1F2; text-align: center; }
    </style>
    </head>
    <body>
      <table>
        <tr>
          <td colspan="9" class="title-banner">LAPORAN DATA TELEMETRI SENSOR - SMART ROLLER BLIND IOT</td>
        </tr>
        <tr>
          <td colspan="9" class="meta-info">Tanggal Filter: <b>${filterTag}</b> &nbsp;|&nbsp; Waktu Ekspor: ${exportTimeStr} &nbsp;|&nbsp; Metode Keputusan: <b>Fuzzy Sugeno Orde-0</b></td>
        </tr>
        <tr><td colspan="9" style="height: 12px;"></td></tr>
        <thead>
          <tr>
            <th style="background-color: #1E3A8A; color: #FFFFFF; width: 50px;">No</th>
            <th style="background-color: #1E3A8A; color: #FFFFFF; width: 110px;">Tanggal</th>
            <th style="background-color: #1E3A8A; color: #FFFFFF; width: 95px;">Waktu</th>
            <th style="background-color: #BE123C; color: #FFFFFF; width: 110px;">Suhu (°C)</th>
            <th style="background-color: #0284C7; color: #FFFFFF; width: 120px;">Kelembaban (%)</th>
            <th style="background-color: #7C3AED; color: #FFFFFF; width: 135px;">Sensor Hujan 1 (%)</th>
            <th style="background-color: #059669; color: #FFFFFF; width: 135px;">Sensor Hujan 2 (%)</th>
            <th style="background-color: #D97706; color: #FFFFFF; width: 130px;">Skor Fuzzy Z</th>
            <th style="background-color: #334155; color: #FFFFFF; width: 110px;">Status Tirai</th>
          </tr>
        </thead>
        <tbody>
    `;

    dataToExport.forEach((row, idx) => {
        const isAlt = idx % 2 === 1 ? ' class="row-alt"' : '';
        const tempVal = Number(row.temp).toFixed(1);
        const fzVal = row.fuzzyScore !== null && row.fuzzyScore !== undefined ? Number(row.fuzzyScore).toFixed(3) : null;
        const isClosed = row.blindStatus === 'closed';
        const statusClass = isClosed ? 'status-closed' : 'status-open';
        const statusText = isClosed ? 'Tutup' : 'Buka';

        tableHtml += `
          <tr${isAlt}>
            <td class="num-int" x:num="${idx + 1}">${idx + 1}</td>
            <td class="text-cell">${row.date}</td>
            <td class="text-cell">${row.time}</td>
            <td class="num-temp" x:num="${tempVal}">${tempVal}</td>
            <td class="num-int" x:num="${row.hum}">${row.hum}</td>
            <td class="num-int" x:num="${row.rain1}">${row.rain1}</td>
            <td class="num-int" x:num="${row.rain2}">${row.rain2}</td>
            ${fzVal !== null ? `<td class="num-fz" x:num="${fzVal}">${fzVal}</td>` : `<td class="text-cell">-</td>`}
            <td class="${statusClass}">${statusText}</td>
          </tr>
        `;
    });

    tableHtml += `
        </tbody>
      </table>
    </body>
    </html>
    `;

    const blob = new Blob(["\uFEFF" + tableHtml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Data_Telemetri_Sensor_${filterTag}_${Date.now()}.xls`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addLog('info', `Berhasil mengekspor ${dataToExport.length} data ke Excel (.xls) dengan tabel rapi & header berwarna`);
}

function exportSensorCSV() {
    const dataToExport = getFilteredSensorData();
    if (dataToExport.length === 0) {
        alert('Tidak ada data sensor pada tanggal yang dipilih untuk diekspor!');
        return;
    }

    // Menggunakan pemisah titik koma (;) dan direktif sep=; agar Excel versi Windows & Mac langsung membagi kolom rapi A-I
    let csvContent = "sep=;\r\n";
    csvContent += "No;Tanggal;Waktu;Suhu (C);Kelembaban (%);Sensor Hujan 1 (%);Sensor Hujan 2 (%);Skor Fuzzy Sugeno Z;Status Tirai\r\n";
    dataToExport.forEach((row, idx) => {
        const fz = row.fuzzyScore !== null ? row.fuzzyScore : "-";
        const st = row.blindStatus === 'closed' ? 'Tutup' : 'Buka';
        csvContent += `${idx + 1};${row.date};${row.time};${row.temp};${row.hum};${row.rain1};${row.rain2};${fz};${st}\r\n`;
    });

    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filterTag = selectedDateFilter === 'all' ? 'Semua_Tanggal' : selectedDateFilter;
    a.download = `Data_Sensor_Jemuran_${filterTag}_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addLog('info', `Berhasil mengekspor ${dataToExport.length} baris data ke CSV`);
}

function exportSensorJSON() {
    const dataToExport = getFilteredSensorData();
    if (dataToExport.length === 0) {
        alert('Tidak ada data sensor pada tanggal yang dipilih!');
        return;
    }
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filterTag = selectedDateFilter === 'all' ? 'Semua_Tanggal' : selectedDateFilter;
    a.download = `Data_Sensor_Jemuran_${filterTag}_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    addLog('info', `Berhasil mengekspor ${dataToExport.length} data sensor ke JSON`);
}

function toggleDHTDataset(index) {
    if (!dhtChart) return;
    const isVisible = dhtChart.isDatasetVisible(index);
    dhtChart.setDatasetVisibility(index, !isVisible);
    dhtChart.update();

    const pills = document.querySelectorAll('.unified-chart-card:first-of-type .legend-toggle-pill');
    if (pills[index]) {
        pills[index].classList.toggle('active', !isVisible);
    }
}

function toggleRainDataset(index) {
    if (!rainChart) return;
    const isVisible = rainChart.isDatasetVisible(index);
    rainChart.setDatasetVisibility(index, !isVisible);
    rainChart.update();

    const pills = document.querySelectorAll('.unified-chart-card:nth-of-type(2) .legend-toggle-pill');
    if (pills[index]) {
        pills[index].classList.toggle('active', !isVisible);
    }
}

// ==================== HERO CANVAS ANIMATION ====================
function initHeroCanvas() {
    canvas = document.getElementById('weatherCanvas');
    if (!canvas) return;
    ctx = canvas.getContext('2d');

    function resize() {
        const stage = canvas.parentElement;
        if (!stage) return;
        canvas.width = stage.clientWidth;
        canvas.height = stage.clientHeight;
        initParticles();
    }

    resize();
    window.addEventListener('resize', resize);
    animateHeroStage();
}

function initParticles() {
    if (!canvas) return;

    windLines = [];
    for (let i = 0; i < 6; i++) {
        windLines.push({
            x: Math.random() * canvas.width,
            y: Math.random() * (canvas.height * 0.6) + 50,
            length: Math.random() * 120 + 80,
            speed: Math.random() * 3 + 2,
            opacity: Math.random() * 0.3 + 0.1
        });
    }

    flyingLeaves = [];
    for (let i = 0; i < 14; i++) {
        flyingLeaves.push({
            x: Math.random() * canvas.width,
            y: Math.random() * (canvas.height * 0.7),
            size: Math.random() * 8 + 6,
            angle: Math.random() * Math.PI * 2,
            rotSpeed: (Math.random() - 0.5) * 0.08,
            speedX: Math.random() * 2.5 + 2,
            speedY: Math.sin(Math.random() * 5) * 1.2
        });
    }
}

function animateHeroStage() {
    if (!canvas || !ctx) {
        animationFrame = requestAnimationFrame(animateHeroStage);
        return;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const isRain = latestData.isRaining;

    ctx.lineWidth = 1.2;
    windLines.forEach(w => {
        ctx.strokeStyle = `rgba(255, 255, 255, ${w.opacity})`;
        ctx.beginPath();
        ctx.moveTo(w.x, w.y);
        ctx.quadraticCurveTo(w.x + w.length * 0.5, w.y - 12, w.x + w.length, w.y);
        ctx.stroke();

        w.x += w.speed;
        if (w.x > canvas.width + w.length) {
            w.x = -w.length;
            w.y = Math.random() * (canvas.height * 0.6) + 50;
        }
    });

    flyingLeaves.forEach(leaf => {
        ctx.save();
        ctx.translate(leaf.x, leaf.y);
        ctx.rotate(leaf.angle);

        ctx.fillStyle = '#10B981';
        ctx.beginPath();
        ctx.ellipse(0, 0, leaf.size, leaf.size * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        leaf.x += leaf.speedX;
        leaf.y += Math.sin(Date.now() / 400 + leaf.x) * 0.8;
        leaf.angle += leaf.rotSpeed;

        if (leaf.x > canvas.width + 30) {
            leaf.x = -30;
            leaf.y = Math.random() * (canvas.height * 0.7);
        }
    });

    // 3. Draw Raindrops if raining
    if (isRain) {
        if (raindrops.length < 80) {
            for (let i = 0; i < 4; i++) {
                raindrops.push({
                    x: Math.random() * canvas.width,
                    y: -15,
                    speed: Math.random() * 5 + 8,
                    length: Math.random() * 18 + 10
                });
            }
        }

        ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
        ctx.lineWidth = 1.5;
        raindrops.forEach((d, idx) => {
            ctx.beginPath();
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(d.x - 2, d.y + d.length);
            ctx.stroke();
            d.y += d.speed;
            d.x -= 1;
            if (d.y > canvas.height) raindrops.splice(idx, 1);
        });
    }

    animationFrame = requestAnimationFrame(animateHeroStage);
}

// ==================== FIREBASE REALTIME CLOUD ====================
function initFirebase() {
    try {
        if (typeof firebase !== 'undefined') {
            if (!firebase.apps.length) {
                firebase.initializeApp(firebaseConfig);
            }
            db = firebase.database();
            isFirebaseReady = true;

            const pulseDot = document.getElementById('systemPulseDot');
            const cloudText = document.getElementById('systemCloudText');
            if (pulseDot) pulseDot.className = 'dot';
            if (cloudText) cloudText.textContent = 'Cloud Synced';

            db.ref('jemuran/status').on('value', (snapshot) => {
                const data = snapshot.val();
                if (data) updateDashboard(data, false);
            });

            db.ref('jemuran/history').limitToLast(2000).once('value', (snapshot) => {
                const historyData = snapshot.val();
                if (historyData && fullSensorHistory.length === 0) {
                    Object.entries(historyData).forEach(([key, item]) => {
                        fullSensorHistory.push(parseSensorRecord(item, key));
                    });
                    updateSeparateCharts();
                }
            });

            db.ref('jemuran/logs').limitToLast(35).on('value', (snapshot) => {
                const logsData = snapshot.val();
                if (logsData) {
                    logs = Object.values(logsData);
                    renderLogs();
                }
            });

            addLog('info', 'Firebase Cloud Database connected');
        }
    } catch (e) {
        console.error('Firebase error:', e);
    }
}

// ==================== MQTT COMMUNICATION ====================
function connectMQTT() {
    mqttClient = mqtt.connect(MQTT_BROKER, {
        clientId: clientId,
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 5000
    });

    mqttClient.on('connect', () => {
        addLog('info', 'MQTT Connected to HiveMQ Broker (Port 8884)');
        mqttClient.subscribe(TOPIC_STATUS);
    });

    mqttClient.on('message', (topic, message) => {
        if (topic === TOPIC_STATUS) {
            try {
                const data = JSON.parse(message.toString());
                updateDashboard(data, true);
            } catch (e) {}
        }
    });
}

function publishMQTT(topic, message) {
    if (mqttClient && mqttClient.connected) {
        mqttClient.publish(topic, message);
        addLog('info', `Published [${topic}]: ${message}`);
    }

    if (isFirebaseReady && db) {
        if (topic === TOPIC_CONTROL) {
            db.ref('jemuran/control').set({ command: message, timestamp: Date.now() }).catch(() => {});
        } else if (topic === TOPIC_MODE) {
            db.ref('jemuran/mode').set({ mode: message, timestamp: Date.now() }).catch(() => {});
        }
    }
}

// ==================== CONTROLS ====================
function setMode(mode) {
    currentMode = mode;
    const btnAuto = document.getElementById('btnModeAuto');
    const btnManual = document.getElementById('btnModeManual');
    const sidebarMode = document.getElementById('currentModeSidebar');
    const modeDisplay = document.getElementById('currentModeDisplay');

    if (btnAuto) btnAuto.classList.toggle('active', mode === 'auto');
    if (btnManual) btnManual.classList.toggle('active', mode === 'manual');
    if (sidebarMode) sidebarMode.textContent = mode.toUpperCase();
    if (modeDisplay) modeDisplay.textContent = mode.toUpperCase();

    publishMQTT(TOPIC_MODE, mode);
    addLog('info', `Mode switched to: ${mode.toUpperCase()}`);
}

function controlBlind(action) {
    publishMQTT(TOPIC_CONTROL, action);
    
    const motorStatusDisplay = document.getElementById('motorStatusDisplay');
    if (motorStatusDisplay) {
        motorStatusDisplay.textContent = action.toUpperCase();
        motorStatusDisplay.style.color = (action === 'turun') ? 'var(--rose)' : 'var(--emerald)';
    }

    if (action === 'naik') {
        updateActuatorUI(100);
        addLog('info', 'Motor command: Buka Jemuran (NAIK)');
    } else if (action === 'turun') {
        updateActuatorUI(0);
        addLog('info', 'Motor command: Tutup Jemuran (TURUN)');
    }
}

// ==================== LOGS TERMINAL ====================
function addLog(type, msg) {
    const timestamp = new Date().toLocaleTimeString('id-ID');
    const log = { type, msg, timestamp };
    logs.push(log);
    if (logs.length > 50) logs.shift();
    renderLogs();

    if (isFirebaseReady && db) {
        db.ref('jemuran/logs').push(log).catch(() => {});
    }
}

function renderLogs() {
    const terminal = document.getElementById('logTerminal');
    if (!terminal) return;
    terminal.innerHTML = logs.slice().reverse().map(l => `
        <div class="log-row ${l.type}">
            <span class="log-timestamp">[${l.timestamp}]</span>
            <span>${l.msg}</span>
        </div>
    `).join('');
}

function clearLogs() {
    logs = [];
    renderLogs();
    if (isFirebaseReady && db) db.ref('jemuran/logs').remove();
    addLog('info', 'Logs cleared');
}

function exportLogs() {
    const dataStr = JSON.stringify(logs, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logs_${Date.now()}.json`;
    a.click();
}
