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

let mqttClient;
let clientId = 'ESP32_Dashboard_' + Math.random().toString(16).substr(2, 8);

// ==================== GLOBAL VARIABLES ====================
let currentTheme = 'purple';

let sensorHistory = {
    temp: [],
    hum: [],
    rain1: [],
    rain2: [],
    timestamps: [],
    blindStatus: []
};

let todayStats = {
    rainCount: 0,
    tempSum: 0,
    humSum: 0,
    tempCount: 0,
    humCount: 0,
    blindActiveCount: 0,
    lastRainState: false,
    lastBlindState: 'open'
};

let logs = [];
let currentMode = 'auto';

let tempHumChart, rainChart, blindChart;

let canvas, ctx;
let clouds = [];
let raindrops = [];
let stars = [];
let isDaytime = true;
let isRaining = false;
let blindClosed = false;
let animationFrame;

// ==================== FIREBASE INIT & LISTENERS ====================
function initFirebase() {
    try {
        if (typeof firebase !== 'undefined') {
            if (!firebase.apps.length) {
                firebase.initializeApp(firebaseConfig);
            }
            db = firebase.database();
            isFirebaseReady = true;
            console.log('Firebase Realtime Database initialized successfully');
            
            const fbStatusEl = document.getElementById('firebaseStatus');
            if (fbStatusEl) {
                fbStatusEl.textContent = 'Connected (Real-time Cloud Sync Active)';
                fbStatusEl.style.color = '#4CAF50';
            }

            // 1. Listen for latest status in real-time
            db.ref('jemuran/status').on('value', (snapshot) => {
                const data = snapshot.val();
                if (data) {
                    updateDashboard(data, false); // false = jangan loop balik kirim ke Firebase
                }
            });

            // 2. Load cloud sensor history for all users
            db.ref('jemuran/history').limitToLast(25).on('value', (snapshot) => {
                const historyData = snapshot.val();
                if (historyData) {
                    const temp = [], hum = [], rain1 = [], rain2 = [], timestamps = [], blindStatus = [];
                    Object.values(historyData).forEach(item => {
                        timestamps.push(item.time || '');
                        temp.push(item.temp || 0);
                        hum.push(item.hum || 0);
                        rain1.push(item.rain1 || 0);
                        rain2.push(item.rain2 || 0);
                        blindStatus.push(item.blindStatus === 'closed' ? 1 : 0);
                    });
                    sensorHistory = { temp, hum, rain1, rain2, timestamps, blindStatus };
                    updateCharts();
                }
            });

            // 3. Listen for logs
            db.ref('jemuran/logs').limitToLast(30).on('value', (snapshot) => {
                const logsData = snapshot.val();
                if (logsData) {
                    logs = Object.values(logsData);
                    displayLogs();
                }
            });
            
            addLog('info', 'Firebase Cloud Database connected');
        }
    } catch (err) {
        console.error('Firebase initialization error:', err);
        const fbStatusEl = document.getElementById('firebaseStatus');
        if (fbStatusEl) {
            fbStatusEl.textContent = 'Error connecting: ' + err.message;
            fbStatusEl.style.color = '#f44336';
        }
    }
}

// ==================== MQTT FUNCTIONS ====================
function connectMQTT() {
    addLog('info', 'Connecting to MQTT broker...');
    const mqttStatusEl = document.getElementById('mqttStatus');
    if (mqttStatusEl) {
        mqttStatusEl.textContent = 'Connecting...';
        mqttStatusEl.style.color = '#ff9800';
    }
    
    mqttClient = mqtt.connect(MQTT_BROKER, {
        clientId: clientId,
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 5000
    });

    mqttClient.on('connect', () => {
        addLog('info', 'MQTT Connected!');
        const statusInd = document.getElementById('statusIndicator');
        const connStatus = document.getElementById('connectionStatus');
        const mqttStatus = document.getElementById('mqttStatus');
        
        if (statusInd) statusInd.className = 'status-indicator online';
        if (connStatus) connStatus.textContent = 'Online (Cloud & MQTT)';
        if (mqttStatus) {
            mqttStatus.textContent = 'Connected (Port 8884)';
            mqttStatus.style.color = '#4CAF50';
        }
        
        mqttClient.subscribe(TOPIC_STATUS, (err) => {
            if (!err) {
                addLog('info', `Subscribed to ${TOPIC_STATUS}`);
            }
        });
    });

    mqttClient.on('message', (topic, message) => {
        if (topic === TOPIC_STATUS) {
            try {
                const data = JSON.parse(message.toString());
                updateDashboard(data, true); // true = sync ke Firebase jika MQTT yang duluan dapat
            } catch (e) {
                addLog('error', 'Failed to parse MQTT message');
            }
        }
    });

    mqttClient.on('error', (err) => {
        addLog('error', `MQTT Error: ${err.message}`);
        const mqttStatus = document.getElementById('mqttStatus');
        if (mqttStatus) {
            mqttStatus.textContent = 'Error';
            mqttStatus.style.color = '#f44336';
        }
    });

    mqttClient.on('offline', () => {
        addLog('warning', 'MQTT Offline');
        const statusInd = document.getElementById('statusIndicator');
        const connStatus = document.getElementById('connectionStatus');
        const mqttStatus = document.getElementById('mqttStatus');
        
        if (statusInd && !isFirebaseReady) statusInd.className = 'status-indicator offline';
        if (connStatus) connStatus.textContent = isFirebaseReady ? 'Online (Firebase Cloud)' : 'Disconnected';
        if (mqttStatus) {
            mqttStatus.textContent = 'Offline';
            mqttStatus.style.color = '#f44336';
        }
    });

    mqttClient.on('reconnect', () => {
        addLog('info', 'Reconnecting to MQTT...');
        const mqttStatus = document.getElementById('mqttStatus');
        if (mqttStatus) {
            mqttStatus.textContent = 'Reconnecting...';
            mqttStatus.style.color = '#ff9800';
        }
    });
}

function reconnectMQTT() {
    if (mqttClient) {
        mqttClient.end(true);
    }
    setTimeout(() => {
        connectMQTT();
    }, 500);
}

function publishMQTT(topic, message) {
    if (mqttClient && mqttClient.connected) {
        mqttClient.publish(topic, message);
        addLog('info', `Published to ${topic}: ${message}`);
    }
    
    // Simpan juga ke Firebase Realtime Database
    if (isFirebaseReady && db) {
        if (topic === TOPIC_CONTROL) {
            db.ref('jemuran/control').set({ command: message, timestamp: Date.now() });
        } else if (topic === TOPIC_MODE) {
            db.ref('jemuran/mode').set({ mode: message, timestamp: Date.now() });
        }
    }
}

// ==================== UPDATE DASHBOARD ====================
function updateDashboard(data, syncToCloud = false) {
    if (!data) return;
    
    // Update sensor displays
    const tempEl = document.getElementById('temp');
    const humEl = document.getElementById('hum');
    const rain1El = document.getElementById('rain1');
    const rain2El = document.getElementById('rain2');
    const blindStatusEl = document.getElementById('blindStatus');
    const weatherConditionEl = document.getElementById('weatherCondition');
    const currentModeEl = document.getElementById('currentMode');

    if (tempEl) tempEl.textContent = Number(data.temp || 0).toFixed(1);
    if (humEl) humEl.textContent = Number(data.hum || 0).toFixed(1);
    if (rain1El) rain1El.textContent = data.rain1 || 0;
    if (rain2El) rain2El.textContent = data.rain2 || 0;
    
    if (blindStatusEl) blindStatusEl.textContent = data.blindStatus === 'closed' ? 'CLOSED' : 'OPEN';
    if (weatherConditionEl) weatherConditionEl.textContent = data.isRaining ? '🌧️' : '☀️';
    if (data.mode && currentModeEl) currentModeEl.textContent = data.mode.toUpperCase();
    
    const now = new Date();
    isDaytime = now.getHours() >= 6 && now.getHours() < 18;
    isRaining = data.isRaining || false;
    blindClosed = data.blindStatus === 'closed';
    
    const timestamp = new Date().toLocaleTimeString('id-ID');
    
    // Sync to Firebase Cloud if received from MQTT
    if (syncToCloud && isFirebaseReady && db) {
        db.ref('jemuran/status').set({
            temp: Number(data.temp || 0),
            hum: Number(data.hum || 0),
            rain1: Number(data.rain1 || 0),
            rain2: Number(data.rain2 || 0),
            blindStatus: data.blindStatus || 'open',
            isRaining: Boolean(data.isRaining),
            mode: data.mode || currentMode,
            lastUpdate: Date.now()
        });

        // Simpan titik riwayat
        db.ref('jemuran/history').push({
            time: timestamp,
            temp: Number(data.temp || 0),
            hum: Number(data.hum || 0),
            rain1: Number(data.rain1 || 0),
            rain2: Number(data.rain2 || 0),
            blindStatus: data.blindStatus || 'open'
        });
    }

    // Local Array Updates
    if (!sensorHistory.timestamps) sensorHistory.timestamps = [];
    if (!sensorHistory.temp) sensorHistory.temp = [];
    if (!sensorHistory.hum) sensorHistory.hum = [];
    if (!sensorHistory.rain1) sensorHistory.rain1 = [];
    if (!sensorHistory.rain2) sensorHistory.rain2 = [];
    if (!sensorHistory.blindStatus) sensorHistory.blindStatus = [];
    
    sensorHistory.timestamps.push(timestamp);
    sensorHistory.temp.push(Number(data.temp || 0));
    sensorHistory.hum.push(Number(data.hum || 0));
    sensorHistory.rain1.push(Number(data.rain1 || 0));
    sensorHistory.rain2.push(Number(data.rain2 || 0));
    sensorHistory.blindStatus.push(data.blindStatus === 'closed' ? 1 : 0);
    
    saveHistory();
    updateCharts();
    
    todayStats.tempSum += Number(data.temp || 0);
    todayStats.humSum += Number(data.hum || 0);
    todayStats.tempCount++;
    todayStats.humCount++;
    
    if (data.isRaining && !todayStats.lastRainState) {
        todayStats.rainCount++;
        addLog('warning', 'Rain detected!');
    }
    todayStats.lastRainState = Boolean(data.isRaining);
    
    if (data.blindStatus === 'closed' && todayStats.lastBlindState === 'open') {
        todayStats.blindActiveCount++;
        addLog('info', 'Blind closed');
    }
    todayStats.lastBlindState = data.blindStatus || 'open';
    
    updateStatsDisplay();
    saveStats();
}

// ==================== INITIALIZATION ====================
window.addEventListener('load', () => {
    const clientIdEl = document.getElementById('clientId');
    if (clientIdEl) clientIdEl.value = clientId;
    loadSettings();
    
    setTimeout(() => {
        initCanvas();
    }, 100);
    
    initCharts();
    addLog('info', 'Dashboard initialized');
    
    // Inisialisasi Firebase & MQTT
    initFirebase();
    connectMQTT();
});

// ==================== STORAGE FUNCTIONS ====================
function loadSettings() {
    const settings = JSON.parse(localStorage.getItem('dashboardSettings') || '{}');
    
    if (settings.dashboardName) {
        const titleEl = document.getElementById('dashboardTitle');
        const nameEl = document.getElementById('dashboardName');
        if (titleEl) titleEl.textContent = settings.dashboardName;
        if (nameEl) nameEl.value = settings.dashboardName;
    }
    if (settings.theme) {
        currentTheme = settings.theme;
        applyTheme(currentTheme);
        document.querySelectorAll('.theme-option').forEach((opt, idx) => {
            opt.classList.remove('selected');
            const themes = ['purple', 'blue', 'green', 'orange'];
            if (themes[idx] === currentTheme) {
                opt.classList.add('selected');
            }
        });
    }
    
    const savedStats = JSON.parse(localStorage.getItem('todayStats') || '{}');
    const today = new Date().toDateString();
    if (savedStats.date === today) {
        todayStats = savedStats;
        updateStatsDisplay();
    }
}

function saveSettings() {
    const nameEl = document.getElementById('dashboardName');
    const settings = {
        dashboardName: nameEl ? nameEl.value : '🌤️ Smart Jemuran IoT',
        theme: currentTheme
    };
    localStorage.setItem('dashboardSettings', JSON.stringify(settings));
}

function saveStats() {
    todayStats.date = new Date().toDateString();
    localStorage.setItem('todayStats', JSON.stringify(todayStats));
}

function saveHistory() {
    if (sensorHistory.timestamps.length > 100) {
        Object.keys(sensorHistory).forEach(key => {
            sensorHistory[key] = sensorHistory[key].slice(-100);
        });
    }
    localStorage.setItem('sensorHistory', JSON.stringify(sensorHistory));
}

function saveLogs() {
    if (logs.length > 500) {
        logs = logs.slice(-500);
    }
    localStorage.setItem('activityLogs', JSON.stringify(logs));
}

// ==================== TAB NAVIGATION ====================
function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const targetTab = document.getElementById(tabName);
    if (targetTab) targetTab.classList.add('active');
    if (window.event && window.event.target) {
        window.event.target.classList.add('active');
    }
    
    addLog('info', `Switched to ${tabName} tab`);
}

// ==================== CANVAS ANIMATION ====================
function initCanvas() {
    canvas = document.getElementById('weatherCanvas');
    if (!canvas) {
        setTimeout(initCanvas, 500);
        return;
    }
    
    ctx = canvas.getContext('2d');
    
    function resize() {
        const wrapper = canvas.parentElement;
        if (!wrapper) return;
        const rect = wrapper.getBoundingClientRect();
        
        canvas.width = rect.width;
        canvas.height = rect.height;
        
        initClouds();
        initStars();
    }
    
    resize();
    window.addEventListener('resize', resize);
    animate();
}

function initClouds() {
    if (!canvas || canvas.width === 0) return;
    
    clouds = [];
    for (let i = 0; i < 5; i++) {
        clouds.push({
            x: Math.random() * canvas.width,
            y: Math.random() * 100 + 20,
            width: Math.random() * 80 + 60,
            speed: Math.random() * 0.5 + 0.2
        });
    }
}

function initStars() {
    if (!canvas || canvas.width === 0) return;
    
    stars = [];
    for (let i = 0; i < 50; i++) {
        stars.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height * 0.6,
            size: Math.random() * 2 + 1,
            opacity: Math.random()
        });
    }
}

function drawCloud(cloud) {
    ctx.fillStyle = isDaytime ? 'rgba(255, 255, 255, 0.8)' : 'rgba(100, 100, 120, 0.3)';
    ctx.beginPath();
    ctx.arc(cloud.x, cloud.y, cloud.width * 0.3, 0, Math.PI * 2);
    ctx.arc(cloud.x + cloud.width * 0.3, cloud.y - cloud.width * 0.1, cloud.width * 0.35, 0, Math.PI * 2);
    ctx.arc(cloud.x + cloud.width * 0.6, cloud.y, cloud.width * 0.3, 0, Math.PI * 2);
    ctx.fill();
}

function animate() {
    if (!canvas || !ctx) {
        animationFrame = requestAnimationFrame(animate);
        return;
    }
    
    if (canvas.width === 0 || canvas.height === 0) {
        animationFrame = requestAnimationFrame(animate);
        return;
    }
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (isDaytime) {
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, '#87CEEB');
        gradient.addColorStop(1, '#E0F6FF');
        ctx.fillStyle = gradient;
    } else {
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, '#0c1445');
        gradient.addColorStop(1, '#1a2766');
        ctx.fillStyle = gradient;
    }
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    if (!isDaytime) {
        stars.forEach(star => {
            ctx.fillStyle = `rgba(255, 255, 255, ${star.opacity})`;
            ctx.fillRect(star.x, star.y, star.size, star.size);
            star.opacity += (Math.random() - 0.5) * 0.05;
            star.opacity = Math.max(0.2, Math.min(1, star.opacity));
        });
    }
    
    if (isDaytime) {
        ctx.fillStyle = '#FFD700';
        ctx.shadowBlur = 30;
        ctx.shadowColor = '#FFD700';
        ctx.beginPath();
        ctx.arc(canvas.width - 80, 60, 40, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    } else {
        ctx.fillStyle = '#F0F0F0';
        ctx.shadowBlur = 20;
        ctx.shadowColor = '#F0F0F0';
        ctx.beginPath();
        ctx.arc(canvas.width - 80, 60, 35, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
    
    clouds.forEach(cloud => {
        drawCloud(cloud);
        cloud.x += cloud.speed;
        if (cloud.x > canvas.width + cloud.width) {
            cloud.x = -cloud.width;
        }
    });
    
    if (isRaining) {
        if (raindrops.length < 100) {
            for (let i = 0; i < 5; i++) {
                raindrops.push({
                    x: Math.random() * canvas.width,
                    y: -10,
                    speed: Math.random() * 3 + 5,
                    length: Math.random() * 15 + 10
                });
            }
        }
        
        ctx.strokeStyle = '#4A90E2';
        ctx.lineWidth = 2;
        raindrops.forEach((drop, index) => {
            ctx.beginPath();
            ctx.moveTo(drop.x, drop.y);
            ctx.lineTo(drop.x, drop.y + drop.length);
            ctx.stroke();
            
            drop.y += drop.speed;
            if (drop.y > canvas.height) {
                raindrops.splice(index, 1);
            }
        });
    } else {
        raindrops = [];
    }
    
    ctx.fillStyle = '#8B7355';
    ctx.fillRect(0, canvas.height - 60, canvas.width, 60);
    
    ctx.fillStyle = '#90EE90';
    for (let i = 0; i < canvas.width; i += 5) {
        ctx.fillRect(i, canvas.height - 65, 2, 8);
    }
    
    const jemuranX = canvas.width / 2;
    const jemuranY = canvas.height - 120;
    
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(jemuranX - 100, jemuranY, 8, 100);
    ctx.fillRect(jemuranX + 92, jemuranY, 8, 100);
    
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(jemuranX - 100, jemuranY + 20);
    ctx.lineTo(jemuranX + 100, jemuranY + 20);
    ctx.stroke();
    
    const windEffect = Math.sin(Date.now() / 500) * 2;
    const colors = ['#FF6B6B', '#4ECDC4', '#FFE66D', '#95E1D3'];
    for (let i = 0; i < 4; i++) {
        ctx.fillStyle = colors[i];
        ctx.save();
        ctx.translate(jemuranX - 85 + i * 50, jemuranY + 23);
        ctx.rotate(windEffect * 0.02);
        ctx.fillRect(0, 0, 35, 40);
        ctx.restore();
    }
    
    if (blindClosed) {
        const maxBlindHeight = 150;
        ctx.fillStyle = 'rgba(80, 80, 80, 0.85)';
        ctx.fillRect(jemuranX - 110, jemuranY - 10, 220, maxBlindHeight);
        
        ctx.strokeStyle = 'rgba(60, 60, 60, 0.5)';
        ctx.lineWidth = 1;
        for (let i = 0; i < maxBlindHeight; i += 10) {
            ctx.beginPath();
            ctx.moveTo(jemuranX - 110, jemuranY - 10 + i);
            ctx.lineTo(jemuranX + 110, jemuranY - 10 + i);
            ctx.stroke();
        }
        
        ctx.fillStyle = '#555';
        ctx.fillRect(jemuranX - 110, jemuranY - 10 + maxBlindHeight - 5, 220, 5);
    }
    
    animationFrame = requestAnimationFrame(animate);
}

// ==================== CHARTS ====================
function initCharts() {
    const tempHumCanvas = document.getElementById('tempHumChart');
    if (tempHumCanvas) {
        const tempHumCtx = tempHumCanvas.getContext('2d');
        tempHumChart = new Chart(tempHumCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Suhu (°C)',
                    data: [],
                    borderColor: '#ff6384',
                    backgroundColor: 'rgba(255, 99, 132, 0.1)',
                    tension: 0.4
                }, {
                    label: 'Kelembaban (%)',
                    data: [],
                    borderColor: '#36a2eb',
                    backgroundColor: 'rgba(54, 162, 235, 0.1)',
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true }
                }
            }
        });
    }

    const rainCanvas = document.getElementById('rainChart');
    if (rainCanvas) {
        const rainCtx = rainCanvas.getContext('2d');
        rainChart = new Chart(rainCtx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Sensor Hujan 1 (%)',
                    data: [],
                    borderColor: '#4bc0c0',
                    backgroundColor: 'rgba(75, 192, 192, 0.1)',
                    tension: 0.4
                }, {
                    label: 'Sensor Hujan 2 (%)',
                    data: [],
                    borderColor: '#9966ff',
                    backgroundColor: 'rgba(153, 102, 255, 0.1)',
                    tension: 0.4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, max: 100 }
                }
            }
        });
    }

    const blindCanvas = document.getElementById('blindChart');
    if (blindCanvas) {
        const blindCtx = blindCanvas.getContext('2d');
        blindChart = new Chart(blindCtx, {
            type: 'bar',
            data: {
                labels: [],
                datasets: [{
                    label: 'Status Blind (0=Open, 1=Closed)',
                    data: [],
                    backgroundColor: '#ffce56'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, max: 1 }
                }
            }
        });
    }
}

function updateCharts() {
    if (!tempHumChart || !rainChart || !blindChart) return;
    if (!sensorHistory || !sensorHistory.timestamps) return;
    
    const sliceCount = -20;
    tempHumChart.data.labels = sensorHistory.timestamps.slice(sliceCount);
    tempHumChart.data.datasets[0].data = sensorHistory.temp.slice(sliceCount);
    tempHumChart.data.datasets[1].data = sensorHistory.hum.slice(sliceCount);
    tempHumChart.update('none');

    rainChart.data.labels = sensorHistory.timestamps.slice(sliceCount);
    rainChart.data.datasets[0].data = sensorHistory.rain1.slice(sliceCount);
    rainChart.data.datasets[1].data = sensorHistory.rain2.slice(sliceCount);
    rainChart.update('none');

    blindChart.data.labels = sensorHistory.timestamps.slice(sliceCount);
    blindChart.data.datasets[0].data = sensorHistory.blindStatus.slice(sliceCount);
    blindChart.update('none');
}

// ==================== LOGS ====================
function addLog(type, message) {
    const timestamp = new Date().toLocaleString('id-ID');
    const log = { type, message, timestamp };
    logs.push(log);
    saveLogs();
    displayLogs();

    // Push log to Firebase Cloud
    if (isFirebaseReady && db) {
        db.ref('jemuran/logs').push(log);
    }
}

function displayLogs() {
    const container = document.getElementById('logContainer');
    if (!container) return;
    container.innerHTML = logs.slice(-50).reverse().map(log => 
        `<div class="log-entry ${log.type}">[${log.timestamp}] [${log.type.toUpperCase()}] ${log.message}</div>`
    ).join('');
}

function clearLogs() {
    if (confirm('Hapus semua logs?')) {
        logs = [];
        saveLogs();
        displayLogs();
        if (isFirebaseReady && db) {
            db.ref('jemuran/logs').remove();
        }
        addLog('info', 'Logs cleared');
    }
}

function exportLogs() {
    const dataStr = JSON.stringify(logs, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jemuran_logs_${new Date().toISOString()}.json`;
    a.click();
    addLog('info', 'Logs exported');
}

// ==================== CONTROL ====================
function setMode(mode) {
    currentMode = mode;
    const btnAuto = document.getElementById('btnAuto');
    const btnManual = document.getElementById('btnManual');
    const manualControls = document.getElementById('manualControls');
    const autoInfo = document.getElementById('autoInfo');

    if(mode === 'auto') {
        if (btnAuto) btnAuto.classList.add('active');
        if (btnManual) btnManual.classList.remove('active');
        if (manualControls) manualControls.style.display = 'none';
        if (autoInfo) autoInfo.style.display = 'block';
    } else {
        if (btnAuto) btnAuto.classList.remove('active');
        if (btnManual) btnManual.classList.add('active');
        if (manualControls) manualControls.style.display = 'block';
        if (autoInfo) autoInfo.style.display = 'none';
    }

    publishMQTT(TOPIC_MODE, mode);
    const currentModeEl = document.getElementById('currentMode');
    if (currentModeEl) currentModeEl.textContent = mode.toUpperCase();
}

function controlBlind(action) {
    publishMQTT(TOPIC_CONTROL, action);
    
    if (action === 'turun') {
        blindClosed = true;
    } else if (action === 'naik') {
        blindClosed = false;
    }
}

function updateStatsDisplay() {
    const rainCountEl = document.getElementById('rainCountToday');
    const avgTempEl = document.getElementById('avgTempToday');
    const avgHumEl = document.getElementById('avgHumToday');
    const blindActiveEl = document.getElementById('blindActiveToday');

    if (rainCountEl) rainCountEl.textContent = todayStats.rainCount;
    if (avgTempEl) {
        avgTempEl.textContent = todayStats.tempCount > 0 
            ? (todayStats.tempSum / todayStats.tempCount).toFixed(1) : '--';
    }
    if (avgHumEl) {
        avgHumEl.textContent = todayStats.humCount > 0 
            ? (todayStats.humSum / todayStats.humCount).toFixed(1) : '--';
    }
    if (blindActiveEl) blindActiveEl.textContent = todayStats.blindActiveCount;
}

// ==================== SETTINGS ====================
function saveName() {
    const nameInput = document.getElementById('dashboardName');
    const name = nameInput ? nameInput.value : '';
    const titleEl = document.getElementById('dashboardTitle');
    if (titleEl) titleEl.textContent = name || '🌤️ Smart Jemuran IoT';
    saveSettings();
    addLog('info', `Dashboard name changed to: ${name}`);
    alert('Nama berhasil disimpan!');
}

function setTheme(theme) {
    currentTheme = theme;
    applyTheme(theme);
    saveSettings();
    
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.classList.remove('selected');
    });
    if (window.event && window.event.target) {
        const option = window.event.target.closest('.theme-option');
        if (option) option.classList.add('selected');
    }
    
    addLog('info', `Theme changed to ${theme}`);
}

function applyTheme(theme) {
    const themes = {
        purple: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        blue: 'linear-gradient(135deg, #2196F3 0%, #1976D2 100%)',
        green: 'linear-gradient(135deg, #4CAF50 0%, #2E7D32 100%)',
        orange: 'linear-gradient(135deg, #ff9800 0%, #f57c00 100%)'
    };
    document.body.style.background = themes[theme] || themes.purple;
}

function exportData() {
    const exportData = {
        settings: JSON.parse(localStorage.getItem('dashboardSettings') || '{}'),
        stats: todayStats,
        history: sensorHistory,
        logs: logs
    };
    
    const dataStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jemuran_data_${new Date().toISOString()}.json`;
    a.click();
    addLog('info', 'Data exported');
}

function resetStats() {
    if (confirm('Reset semua statistik hari ini?')) {
        todayStats = {
            rainCount: 0,
            tempSum: 0,
            humSum: 0,
            tempCount: 0,
            humCount: 0,
            blindActiveCount: 0,
            lastRainState: false,
            lastBlindState: 'open'
        };
        updateStatsDisplay();
        saveStats();
        addLog('info', 'Statistics reset');
    }
}

function clearAllData() {
    if (confirm('PERINGATAN: Ini akan menghapus SEMUA data termasuk history dan logs. Lanjutkan?')) {
        localStorage.clear();
        location.reload();
    }
}
