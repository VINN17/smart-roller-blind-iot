// Global Variables
let tempHumChart, rainChart;
let currentMode = 'auto';
let lastRainStatus = false;
let settings = {
    notifications: true
};

// Initialize Charts
function initCharts() {
    const ctx1 = document.getElementById('tempHumChart').getContext('2d');
    tempHumChart = new Chart(ctx1, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Suhu (°C)',
                data: [],
                borderColor: '#f44336',
                backgroundColor: 'rgba(244, 67, 54, 0.1)',
                tension: 0.4
            }, {
                label: 'Kelembaban (%)',
                data: [],
                borderColor: '#2196F3',
                backgroundColor: 'rgba(33, 150, 243, 0.1)',
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: false
                }
            }
        }
    });

    const ctx2 = document.getElementById('rainChart').getContext('2d');
    rainChart = new Chart(ctx2, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Sensor Hujan 1 (%)',
                data: [],
                borderColor: '#4CAF50',
                backgroundColor: 'rgba(76, 175, 80, 0.1)',
                tension: 0.4
            }, {
                label: 'Sensor Hujan 2 (%)',
                data: [],
                borderColor: '#FF9800',
                backgroundColor: 'rgba(255, 152, 0, 0.1)',
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100
                }
            }
        }
    });
}

// Show Notification
function showNotification(message, type = 'info') {
    if (!settings.notifications) return;
    
    const notif = document.getElementById('notification');
    notif.textContent = message;
    notif.className = `notification show alert alert-${type}`;
    
    setTimeout(() => {
        notif.classList.remove('show');
    }, 5000);
    
    // Browser notification
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Smart Jemuran', {
            body: message,
            icon: '🌤️'
        });
    }
}

// Set Mode (Auto/Manual)
function setMode(mode) {
    currentMode = mode;
    
    fetch('/setMode?mode=' + mode)
        .then(response => response.json())
        .then(data => {
            const btnAuto = document.getElementById('btnAuto');
            const btnManual = document.getElementById('btnManual');
            const manualControls = document.getElementById('manualControls');
            const autoInfo = document.getElementById('autoInfo');
            
            if (mode === 'auto') {
                btnAuto.classList.add('active');
                btnManual.classList.remove('active');
                manualControls.style.display = 'none';
                autoInfo.style.display = 'block';
                showNotification('Mode AUTO diaktifkan', 'success');
            } else {
                btnAuto.classList.remove('active');
                btnManual.classList.add('active');
                manualControls.style.display = 'block';
                autoInfo.style.display = 'none';
                showNotification('Mode MANUAL diaktifkan', 'warning');
            }
        })
        .catch(error => {
            console.error('Error setting mode:', error);
            showNotification('Gagal mengubah mode', 'danger');
        });
}

// Control Blind (Manual)
function controlBlind(action) {
    fetch('/control?action=' + action)
        .then(response => response.json())
        .then(data => {
            let message = '';
            if (action === 'naik') message = 'Roller blind NAIK';
            else if (action === 'turun') message = 'Roller blind TURUN';
            else message = 'Roller blind STOP';
            
            showNotification(message, 'success');
        })
        .catch(error => {
            console.error('Error controlling blind:', error);
            showNotification('Gagal mengontrol roller blind', 'danger');
        });
}

// Save Thresholds
function saveThresholds() {
    const data = {
        tempThreshold: parseFloat(document.getElementById('tempThreshold').value),
        humThreshold: parseFloat(document.getElementById('humThreshold').value),
        rainSensitivity: parseInt(document.getElementById('rainSensitivity').value)
    };
    
    fetch('/saveSettings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    })
    .then(response => response.json())
    .then(data => {
        showNotification('Threshold berhasil disimpan', 'success');
    })
    .catch(error => {
        console.error('Error saving thresholds:', error);
        showNotification('Gagal menyimpan threshold', 'danger');
    });
}

// Save Personalization
function savePersonalization() {
    const data = {
        deviceName: document.getElementById('deviceNameInput').value,
        darkMode: document.getElementById('darkModeToggle').checked,
        notifications: document.getElementById('notifToggle').checked
    };
    
    settings.notifications = data.notifications;
    
    fetch('/saveSettings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    })
    .then(response => response.json())
    .then(() => {
        document.getElementById('deviceName').textContent = '🌤️ ' + data.deviceName;
        showNotification('Personalisasi berhasil disimpan', 'success');
    })
    .catch(error => {
        console.error('Error saving personalization:', error);
        showNotification('Gagal menyimpan personalisasi', 'danger');
    });
}

// Load Settings
function loadSettings() {
    fetch('/getSettings')
        .then(response => response.json())
        .then(data => {
            document.getElementById('tempThreshold').value = data.tempThreshold;
            document.getElementById('humThreshold').value = data.humThreshold;
            document.getElementById('rainSensitivity').value = data.rainSensitivity;
            document.getElementById('deviceNameInput').value = data.deviceName;
            document.getElementById('deviceName').textContent = '🌤️ ' + data.deviceName;
            document.getElementById('darkModeToggle').checked = data.darkMode;
            document.getElementById('notifToggle').checked = data.notifications;
            
            settings.notifications = data.notifications;
            
            if (data.darkMode) {
                document.body.classList.add('dark-mode');
            }
        })
        .catch(error => {
            console.error('Error loading settings:', error);
        });
}

// Update Charts
function updateCharts(data) {
    const timeLabel = new Date().toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit'
    });
    
    // Update Temp & Hum Chart
    if (tempHumChart.data.labels.length > 50) {
        tempHumChart.data.labels.shift();
        tempHumChart.data.datasets[0].data.shift();
        tempHumChart.data.datasets[1].data.shift();
    }
    tempHumChart.data.labels.push(timeLabel);
    tempHumChart.data.datasets[0].data.push(data.temp);
    tempHumChart.data.datasets[1].data.push(data.hum);
    tempHumChart.update('none');
    
    // Update Rain Chart
    if (rainChart.data.labels.length > 50) {
        rainChart.data.labels.shift();
        rainChart.data.datasets[0].data.shift();
        rainChart.data.datasets[1].data.shift();
    }
    rainChart.data.labels.push(timeLabel);
    rainChart.data.datasets[0].data.push(data.rain1);
    rainChart.data.datasets[1].data.push(data.rain2);
    rainChart.update('none');
}

// Update Logs
function updateLogs(logs) {
    const container = document.getElementById('logContainer');
    
    if (!logs || logs.length === 0) {
        container.innerHTML = '<p class="text-center text-muted">Belum ada aktivitas</p>';
        return;
    }
    
    container.innerHTML = '';
    logs.forEach(log => {
        const logItem = document.createElement('div');
        logItem.className = 'log-item';
        logItem.innerHTML = `
            <small class="text-muted">${log.timestamp}</small><br>
            <strong>${log.action}</strong><br>
            <span>${log.reason}</span>
        `;
        container.appendChild(logItem);
    });
}

// Draw Canvas Animation
function drawAnimation(hour, isRaining, blindClosed) {
    const canvas = document.getElementById('animCanvas');
    const ctx = canvas.getContext('2d');
    const isDaytime = hour >= 6 && hour < 18;
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Background gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    if (isDaytime) {
        gradient.addColorStop(0, '#87CEEB');
        gradient.addColorStop(1, '#E0F6FF');
    } else {
        gradient.addColorStop(0, '#0c1445');
        gradient.addColorStop(1, '#1a2766');
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw sun or moon
    if (isDaytime) {
        ctx.fillStyle = '#FFD700';
        ctx.beginPath();
        ctx.arc(400, 60, 40, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowColor = '#FFD700';
        ctx.shadowBlur = 20;
        ctx.fill();
        ctx.shadowBlur = 0;
    } else {
        ctx.fillStyle = '#F0F0F0';
        ctx.beginPath();
        ctx.arc(400, 60, 35, 0, Math.PI * 2);
        ctx.fill();
        
        // Stars
        ctx.fillStyle = 'white';
        for (let i = 0; i < 30; i++) {
            const x = Math.random() * canvas.width;
            const y = Math.random() * 200;
            ctx.fillRect(x, y, 2, 2);
        }
    }
    
    // Draw rain
    if (isRaining) {
        ctx.strokeStyle = '#4A90E2';
        ctx.lineWidth = 2;
        for (let i = 0; i < 40; i++) {
            const x = Math.random() * canvas.width;
            const y = Math.random() * canvas.height;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x - 2, y + 15);
            ctx.stroke();
        }
    }
    
    // Draw jemuran structure
    const centerX = canvas.width / 2;
    const baseY = canvas.height - 50;
    
    // Poles
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(centerX - 100, baseY - 100, 8, 100);
    ctx.fillRect(centerX + 92, baseY - 100, 8, 100);
    
    // Rope
    ctx.fillStyle = '#333';
    ctx.fillRect(centerX - 100, baseY - 90, 200, 3);
    
    // Clothes
    const clothes = [
        { x: centerX - 80, color: '#FF6B6B', width: 30, height: 40 },
        { x: centerX - 40, color: '#4ECDC4', width: 25, height: 35 },
        { x: centerX, color: '#FFE66D', width: 28, height: 38 },
        { x: centerX + 40, color: '#95E1D3', width: 26, height: 36 }
    ];
    
    clothes.forEach(cloth => {
        ctx.fillStyle = cloth.color;
        ctx.fillRect(cloth.x, baseY - 87, cloth.width, cloth.height);
    });
    
    // Draw roller blind
    if (blindClosed) {
        ctx.fillStyle = 'rgba(100, 100, 100, 0.7)';
        ctx.fillRect(centerX - 110, 0, 220, baseY - 40);
        ctx.strokeStyle = '#666';
        ctx.lineWidth = 2;
        ctx.strokeRect(centerX - 110, 0, 220, baseY - 40);
    }
}

// Fetch Data from ESP32
function fetchData() {
    fetch('/data')
        .then(response => response.json())
        .then(data => {
            // Update sensor values
            document.getElementById('temp').textContent = data.temp.toFixed(1);
            document.getElementById('hum').textContent = data.hum.toFixed(1);
            document.getElementById('rain1').textContent = data.rain1;
            document.getElementById('rain2').textContent = data.rain2;
            
            // Update statistics
            document.getElementById('rainCount').textContent = data.rainCount;
            document.getElementById('avgTemp').textContent = data.avgTemp.toFixed(1);
            document.getElementById('avgHum').textContent = data.avgHum.toFixed(1);
            document.getElementById('blindChanges').textContent = data.logCount;
            
            // Update weather status
            const weatherStatus = document.getElementById('weatherStatus');
            if (data.isRaining) {
                weatherStatus.textContent = '🌧️ Hujan';
                weatherStatus.className = 'weather-badge bg-primary text-white';
                
                // Notification when rain starts
                if (!lastRainStatus && settings.notifications) {
                    showNotification('⚠️ Hujan terdeteksi! Roller blind akan ditutup', 'warning');
                }
            } else {
                if (data.hour >= 6 && data.hour < 18) {
                    weatherStatus.textContent = '☀️ Cerah';
                    weatherStatus.className = 'weather-badge bg-success text-white';
                } else {
                    weatherStatus.textContent = '🌙 Malam Cerah';
                    weatherStatus.className = 'weather-badge bg-dark text-white';
                }
            }
            
            lastRainStatus = data.isRaining;
            
            // Update charts
            updateCharts(data);
            
            // Update logs
            if (data.logs) {
                updateLogs(data.logs);
            }
            
            // Draw animation
            drawAnimation(data.hour, data.isRaining, data.blindStatus === 'closed');
            
            // Update connection status
            document.getElementById('connectionStatus').innerHTML = '● Online';
            document.getElementById('connectionStatus').className = 'status-online';
        })
        .catch(error => {
            console.error('Error fetching data:', error);
            document.getElementById('connectionStatus').innerHTML = '● Offline';
            document.getElementById('connectionStatus').className = 'status-offline';
        });
}

// Dark Mode Toggle
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('darkModeToggle').addEventListener('change', (e) => {
        document.body.classList.toggle('dark-mode', e.target.checked);
    });
    
    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    
    // Initialize
    initCharts();
    loadSettings();
    fetchData();
    
    // Fetch data every 2 seconds
    setInterval(fetchData, 2000);
});
