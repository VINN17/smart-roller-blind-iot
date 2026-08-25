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

let sensorHistory = {
    timestamps: [],
    temp: [],
    hum: [],
    rain1: [],
    rain2: [],
    blindStatus: []
};

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

    addLog('info', 'SmartJemur PRO UI with separated charts initialized');
});

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
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => item.classList.remove('active'));
    
    if (window.event && window.event.currentTarget) {
        window.event.currentTarget.classList.add('active');
    }

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

    // 3. Condition Card & Fusion
    const condTitle = document.getElementById('conditionHeroTitle');
    const condSub = document.getElementById('conditionHeroSub');
    const condGlow = document.getElementById('conditionIconGlow');
    const weatherPill = document.getElementById('weatherPill');
    const fusionTitle = document.getElementById('fusionBadgeTitle');
    const fusionDesc = document.getElementById('fusionDescText');
    const fusionGauge = document.getElementById('fusionGaugeProg');

    if (isRain) {
        if (condTitle) condTitle.textContent = 'Hujan Terdeteksi';
        if (condSub) condSub.textContent = 'Tirai menutup otomatis';
        if (condGlow) condGlow.textContent = '🌧️';
        if (weatherPill) weatherPill.innerHTML = `<span>🌧️</span><span>Hujan</span>`;
        if (fusionTitle) {
            fusionTitle.textContent = 'Waspada Hujan!';
            fusionTitle.style.color = 'var(--rose)';
        }
        if (fusionDesc) fusionDesc.textContent = 'Sensor mendeteksi presipitasi air hujan. Tirai segera ditutup untuk mengamankan pakaian dari kebasahan.';
        if (fusionGauge) {
            fusionGauge.style.strokeDashoffset = '140';
            fusionGauge.style.stroke = 'var(--rose)';
        }
    } else if (hum > 85 && temp < 27) {
        if (condTitle) condTitle.textContent = 'Mendung (Potensi Hujan)';
        if (condSub) condSub.textContent = 'Kelembaban udara sangat tinggi';
        if (condGlow) condGlow.textContent = '☁️';
        if (weatherPill) weatherPill.innerHTML = `<span>☁️</span><span>Mendung</span>`;
        if (fusionTitle) {
            fusionTitle.textContent = 'Potensi Mendung';
            fusionTitle.style.color = 'var(--amber)';
        }
        if (fusionDesc) fusionDesc.textContent = 'Kelembaban atmosfer melonjak tinggi. Siaga bila sewaktu-waktu turun hujan lebat.';
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
            fusionTitle.textContent = 'Optimal untuk Menjemur';
            fusionTitle.style.color = 'var(--emerald)';
        }
        if (fusionDesc) fusionDesc.textContent = 'Semua parameter lingkungan ideal untuk menjemur pakaian. Kombinasi suhu, kelembaban, angin, dan kondisi kering sangat baik.';
        if (fusionGauge) {
            fusionGauge.style.strokeDashoffset = '25';
            fusionGauge.style.stroke = 'var(--emerald)';
        }
    }

    // 4. Actuator Progress Bar
    updateActuatorUI(isClosed ? 0 : 100);
    updateHeroBackground(isRain);

    // 5. Push Telemetry to Chart History
    const timestamp = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    sensorHistory.timestamps.push(timestamp);
    sensorHistory.temp.push(temp);
    sensorHistory.hum.push(hum);
    sensorHistory.rain1.push(rain1);
    sensorHistory.rain2.push(rain2);
    sensorHistory.blindStatus.push(isClosed ? 1 : 0);

    if (sensorHistory.timestamps.length > 25) {
        sensorHistory.timestamps.shift();
        sensorHistory.temp.shift();
        sensorHistory.hum.shift();
        sensorHistory.rain1.shift();
        sensorHistory.rain2.shift();
        sensorHistory.blindStatus.shift();
    }
    updateSeparateCharts();

    // 6. Dual Cloud Sync
    if (syncToCloud && isFirebaseReady && db) {
        db.ref('jemuran/status').set({
            temp,
            hum,
            rain1,
            rain2,
            blindStatus: isClosed ? 'closed' : 'open',
            isRaining: isRain,
            mode: mode,
            lastUpdate: Date.now()
        }).catch(err => {
            console.warn('Firebase status sync (check Firebase rules):', err.message);
        });

        db.ref('jemuran/history').push({
            time: timestamp,
            temp,
            hum,
            rain1,
            rain2,
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
                        ticks: { color: '#64748B', font: { family: "'Plus Jakarta Sans', sans-serif", size: 11 } }
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
                        ticks: { color: '#64748B', font: { family: "'Plus Jakarta Sans', sans-serif", size: 11 } }
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

function updateSeparateCharts() {
    if (dhtChart) {
        dhtChart.data.labels = sensorHistory.timestamps;
        dhtChart.data.datasets[0].data = sensorHistory.temp;
        dhtChart.data.datasets[1].data = sensorHistory.hum;
        dhtChart.update('none');
    }

    if (rainChart) {
        rainChart.data.labels = sensorHistory.timestamps;
        rainChart.data.datasets[0].data = sensorHistory.rain1;
        rainChart.data.datasets[1].data = sensorHistory.rain2;
        rainChart.update('none');
    }
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

            db.ref('jemuran/history').limitToLast(25).on('value', (snapshot) => {
                const historyData = snapshot.val();
                if (historyData) {
                    const temp = [], hum = [], rain1 = [], rain2 = [], timestamps = [], blindStatus = [];
                    Object.values(historyData).forEach(item => {
                        timestamps.push(item.time || '');
                        temp.push(Number(item.temp || 0));
                        hum.push(Number(item.hum || 0));
                        rain1.push(Number(item.rain1 || 0));
                        rain2.push(Number(item.rain2 || 0));
                        blindStatus.push(item.blindStatus === 'closed' ? 1 : 0);
                    });
                    sensorHistory = { temp, hum, rain1, rain2, timestamps, blindStatus };
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
