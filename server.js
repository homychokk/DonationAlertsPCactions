const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const OBSWebSocket = require('obs-websocket-js').default;

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`;

// State
let wsConnection = null;
let reconnectTimeout = null;
let centrifugoClientId = null;
let userProfile = null;
let logs = [];
let connectionState = 'Disconnected'; // 'Disconnected', 'Connecting', 'Connected', 'Error'

const obs = new OBSWebSocket();
let obsConnected = false;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Add log helper
function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, message, type };
  logs.unshift(logEntry);
  if (logs.length > 50) logs.pop();
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// Config file helper
const CONFIG_PATH = path.join(__dirname, 'config.json');

function loadConfig() {
  let config = {
    clientId: '',
    clientSecret: '',
    accessToken: '',
    refreshToken: '',
    tokenExpiry: 0,
    obs: { address: 'ws://127.0.0.1:4455', password: '' },
    currentGame: 'deadlock',
    games: ['deadlock', 'cs2', 'dota2', 'minecraft', 'gta5', 'apex', 'rust'],
    actions: []
  };

  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      config = { ...config, ...loaded };
    }
  } catch (err) {
    addLog(`Failed to read config: ${err.message}`, 'error');
  }

  if (!config.games || !Array.isArray(config.games)) {
    config.games = ['deadlock', 'cs2', 'dota2', 'minecraft', 'gta5', 'apex', 'rust'];
  }
  return config;
}

function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    addLog(`Failed to save config: ${err.message}`, 'error');
  }
}

// Refresh token helper
async function refreshAccessToken(config) {
  if (!config.refreshToken) {
    throw new Error('No refresh token available');
  }

  addLog('Refreshing DonationAlerts access token...', 'info');
  const response = await fetch('https://www.donationalerts.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  config.accessToken = data.access_token;
  config.refreshToken = data.refresh_token;
  config.tokenExpiry = Date.now() + data.expires_in * 1000;
  saveConfig(config);
  addLog('Token refreshed successfully!', 'success');
  return config.accessToken;
}

// Get valid access token (refreshes if expired)
async function getValidAccessToken() {
  const config = loadConfig();
  if (!config.accessToken) {
    throw new Error('Not authorized. Please connect DonationAlerts first.');
  }

  // If token expires in less than 5 minutes, refresh it
  if (config.tokenExpiry && Date.now() > config.tokenExpiry - 300000) {
    return await refreshAccessToken(config);
  }
  return config.accessToken;
}

// Fetch user profile
async function fetchUserProfile(accessToken) {
  const response = await fetch('https://www.donationalerts.com/api/v1/user/oauth', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status}`);
  }

  const data = await response.json();
  userProfile = data.data; // contains id, code, name, avatar, socket_connection_token
  return userProfile;
}

// Execute trigger action
function triggerAction(donation) {
  const config = loadConfig();
  const amount = Number(donation.amount);
  const currency = donation.currency;
  const messageText = donation.message || '';
  const username = donation.username || 'Аноним';
  const currentGame = config.currentGame || 'deadlock';

  // Parse additional_data to check for media sharing
  let additionalData = {};
  if (donation.additional_data) {
    try {
      if (typeof donation.additional_data === 'string') {
        additionalData = JSON.parse(donation.additional_data);
      } else {
        additionalData = donation.additional_data;
      }
    } catch (e) {}
  }

  const hasMedia = !!(
    additionalData.random_media ||
    additionalData.media ||
    additionalData.media_data ||
    additionalData.video ||
    additionalData.youtube ||
    donation.message_type === 'audio' ||
    donation.message_type === 'video'
  );

  addLog(`New Donation: ${amount} ${currency} from ${username}. Message: "${messageText}"${hasMedia ? ' (Media attached)' : ''}`, 'donation');

  if (hasMedia) {
    addLog(`Actions skipped because the donation has media sharing attached.`, 'info');
    return;
  }

  const matchedActions = [];
  for (const action of config.actions) {
    if (!action.enabled) continue;
    if (amount !== action.minAmount) continue;
    if (action.currency && currency !== action.currency) continue;
    if (action.keyword && !messageText.toLowerCase().includes(action.keyword.toLowerCase())) continue;
    
    // Check if the action matches the currently active game
    let actionGame = action.game;
    if (!actionGame) {
      if (action.type === 'press_binds' || action.type === 'press_keys') {
        actionGame = 'deadlock';
      } else {
        actionGame = 'all';
      }
    }
    
    if (actionGame !== 'all' && actionGame !== currentGame) {
      addLog(`Skipped action "${action.name}" (game is ${actionGame}, active game is ${currentGame})`, 'info');
      continue;
    }
    
    matchedActions.push(action);
  }

  if (matchedActions.length === 0) return;

  for (const action of matchedActions) {
    addLog(`Triggering action: "${action.name}"`, 'success');

    if (action.type === 'youtube') {
      let url = '';
      if (action.youtubeVideoUrl) {
        url = action.youtubeVideoUrl;
      } else if (action.youtubeQuery) {
        url = `https://www.youtube.com/results?search_query=${encodeURIComponent(action.youtubeQuery)}`;
      }

      if (url) {
        addLog(`Opening YouTube: ${url}`, 'info');
        exec(`start "" "${url}"`, (err) => {
          if (err) addLog(`Failed to open YouTube link: ${err.message}`, 'error');
        });
      }
    } else if (action.type === 'command' && action.command) {
      addLog(`Executing local command: "${action.command}"`, 'info');
      exec(action.command, (err, stdout, stderr) => {
        if (err) {
          addLog(`Command failed: ${err.message}`, 'error');
          return;
        }
        if (stdout) console.log(`Command stdout: ${stdout}`);
        if (stderr) console.error(`Command stderr: ${stderr}`);
      });
    } else if (action.type === 'system_mouse_invert') {
      const durationSec = Math.round((action.durationMs || 5000) / 1000);
      addLog(`Triggering system mouse inversion for ${durationSec}s`, 'info');
      exec(`commands\\mouse_inversion\\InvertMouse.exe ${durationSec}`, (err) => {
        if (err) addLog(`Mouse inversion failed: ${err.message}`, 'error');
        else addLog('Mouse inversion completed successfully.', 'success');
      });
    } else if (action.type === 'system_mouse_speed') {
      const durationSec = Math.round((action.durationMs || 5000) / 1000);
      addLog(`Triggering system mouse speed increase for ${durationSec}s`, 'info');
      exec(`commands\\mouse_speed\\SetMouseSpeed.exe ${durationSec} 20`, (err) => {
        if (err) addLog(`Mouse speed modification failed: ${err.message}`, 'error');
        else addLog('Mouse speed modification completed successfully.', 'success');
      });

    } else if (action.type === 'press_binds') {
      addLog(`Triggering bind: ${action.crazyKey} for ${action.durationMs}ms`, 'info');
      exec(`powershell -WindowStyle Hidden -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${action.crazyKey}')"`, (err) => {
        if (err) addLog(`Failed to press ${action.crazyKey}: ${err.message}`, 'error');
        else addLog(`Successfully pressed ${action.crazyKey}!`, 'success');
        
        setTimeout(() => {
          exec(`powershell -WindowStyle Hidden -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${action.normalKey}')"`, (err2) => {
            if (err2) addLog(`Failed to press ${action.normalKey}: ${err2.message}`, 'error');
            else addLog(`Successfully pressed ${action.normalKey} to restore!`, 'success');
          });
        }, action.durationMs || 5000);
      });
    } else if (action.type === 'press_keys') {
      addLog(`Triggering key press: ${action.keys}`, 'info');
      
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.SendKeys]::SendWait('${action.keys}')
      `;
      exec(`powershell -WindowStyle Hidden -NoProfile -Command "${psScript.replace(/\n/g, '; ')}"`, (err) => {
        if (err) addLog(`Failed to press keys: ${err.message}`, 'error');
        else addLog(`Successfully pressed keys: ${action.keys}`, 'success');
      });
    } else if (action.type === 'streamerbot' && action.streamerBotAction) {
      addLog(`Triggering Streamer.bot action: "${action.streamerBotAction}"`, 'info');
      fetch('http://127.0.0.1:8080/DoAction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: { name: action.streamerBotAction },
          args: {
            amount: amount,
            currency: currency,
            user: username,
            message: messageText
          }
        })
      })
      .then(res => {
        if (!res.ok) throw new Error(`Status ${res.status}`);
        addLog(`Streamer.bot action "${action.streamerBotAction}" executed`, 'success');
      })
      .catch(err => {
        addLog(`Streamer.bot error: ${err.message}. Check if HTTP server is enabled on port 8080.`, 'error');
      });
    }
  }
}

// Establish Centrifugo Connection
async function connectToCentrifugo() {
  try {
    connectionState = 'Connecting';
    if (wsConnection) {
      wsConnection.terminate();
    }

    const token = await getValidAccessToken();
    const profile = await fetchUserProfile(token);
    addLog(`Connected to profile: ${profile.name} (ID: ${profile.id})`, 'info');

    const centrifugoUrl = 'wss://centrifugo.donationalerts.com/connection/websocket';
    wsConnection = new WebSocket(centrifugoUrl);

    let messageId = 1;

    wsConnection.on('open', () => {
      addLog('WebSocket connection opened. Authenticating...', 'info');
      
      // Step 1: Connect Command
      const connectMessage = {
        id: messageId++,
        method: 'connect',
        params: {
          token: profile.socket_connection_token
        }
      };
      wsConnection.send(JSON.stringify(connectMessage));
    });

    wsConnection.on('message', async (dataStr) => {
      try {
        const response = JSON.parse(dataStr);
        
        // Handle connect reply
        if (response.id === 1 && response.result) {
          centrifugoClientId = response.result.client;
          connectionState = 'Connected';
          addLog(`Centrifugo Authenticated. Client ID: ${centrifugoClientId}`, 'success');

          // Step 2: Subscribe to channel
          // First, fetch the subscription token via API
          const subChannel = `$alerts:donation_${profile.id}`;
          addLog(`Fetching subscription token for channel: ${subChannel}`, 'info');

          const apiToken = await getValidAccessToken();
          const subResponse = await fetch('https://www.donationalerts.com/api/v1/centrifuge/subscribe', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiToken}`
            },
            body: JSON.stringify({
              channels: [subChannel],
              client: centrifugoClientId
            })
          });

          if (!subResponse.ok) {
            throw new Error(`Failed to get subscription token: ${subResponse.statusText}`);
          }

          const subData = await subResponse.json();
          const channelInfo = subData.channels.find(c => c.channel === subChannel);

          if (!channelInfo || !channelInfo.token) {
            throw new Error('Subscription token missing in response');
          }

          // Send WebSocket subscribe command
          const subscribeMessage = {
            id: messageId++,
            method: 'subscribe',
            params: {
              channel: subChannel,
              token: channelInfo.token
            }
          };
          wsConnection.send(JSON.stringify(subscribeMessage));
          addLog(`WebSocket subscription request sent for ${subChannel}`, 'info');
        }

        // Handle subscription result
        if (response.result && response.result.channel) {
          addLog(`Subscribed to channel: ${response.result.channel}`, 'success');
        }

        // Handle incoming alerts messages
        if (response.result && response.result.data && response.result.data.data) {
          const donationData = response.result.data.data;
          triggerAction(donationData);
        }
      } catch (err) {
        addLog(`Error processing WS message: ${err.message}`, 'error');
      }
    });

    wsConnection.on('close', () => {
      connectionState = 'Disconnected';
      addLog('WebSocket disconnected. Attempting reconnect in 10s...', 'warning');
      scheduleReconnect();
    });

    wsConnection.on('error', (err) => {
      connectionState = 'Error';
      addLog(`WebSocket error: ${err.message}`, 'error');
    });

  } catch (err) {
    connectionState = 'Error';
    addLog(`Centrifugo connection failed: ${err.message}`, 'error');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  reconnectTimeout = setTimeout(() => {
    addLog('Reconnecting to DonationAlerts...', 'info');
    connectToCentrifugo();
  }, 10000);
}

// API Routes
app.get('/api/config', (req, res) => {
  const config = loadConfig();
  // Don't expose clientSecret and accessToken completely for security, but since it's localhost we can return them or partially mask them.
  res.json({
    clientId: config.clientId,
    clientSecret: config.clientSecret ? '********' : '',
    currentGame: config.currentGame || 'deadlock',
    games: config.games || ['deadlock', 'cs2', 'dota2', 'minecraft', 'gta5', 'apex', 'rust'],
    actions: config.actions
  });
});

app.post('/api/config', (req, res) => {
  const { clientId, clientSecret, currentGame, games } = req.body;
  const config = loadConfig();
  if (clientId !== undefined) config.clientId = clientId;
  if (clientSecret !== undefined && clientSecret !== '********') config.clientSecret = clientSecret;
  if (currentGame !== undefined) {
    config.currentGame = currentGame;
    addLog(`Active game changed to: ${currentGame}`, 'info');
  }
  if (games !== undefined) {
    config.games = games;
  }
  saveConfig(config);
  res.json({ success: true });
});

app.post('/api/actions', (req, res) => {
  const { actions } = req.body;
  const config = loadConfig();
  if (actions !== undefined) config.actions = actions;
  saveConfig(config);
  addLog('Triggers list updated', 'info');
  res.json({ success: true });
});

app.get('/api/status', (req, res) => {
  res.json({
    connectionState,
    profile: userProfile,
    logs
  });
});

// Trigger test donation endpoint
app.post('/api/test-donation', (req, res) => {
  const { amount, currency, username, message, additional_data, message_type } = req.body;
  const mockDonation = {
    amount: amount || 10,
    currency: currency || 'RUB',
    username: username || 'ТестДонатер',
    message: message || 'Привет, это тестовый донат!',
    additional_data: additional_data || null,
    message_type: message_type || 'text'
  };
  addLog(`Triggered simulation: test donation of ${mockDonation.amount} ${mockDonation.currency}`, 'info');
  triggerAction(mockDonation);
  res.json({ success: true });
});

// OAuth Flow
app.get('/auth', (req, res) => {
  const config = loadConfig();
  if (!config.clientId) {
    return res.status(400).send('Please save your Client ID in the settings first.');
  }

  const authUrl = `https://www.donationalerts.com/oauth/authorize?client_id=${config.clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=oauth-donation-subscribe oauth-user-show`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Authorization code is missing.');
  }

  try {
    const config = loadConfig();
    addLog('Exchanging auth code for tokens...', 'info');

    const response = await fetch('https://www.donationalerts.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code.toString(),
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: REDIRECT_URI
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to exchange code: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    config.accessToken = data.access_token;
    config.refreshToken = data.refresh_token;
    config.tokenExpiry = Date.now() + data.expires_in * 1000;
    saveConfig(config);
    addLog('Tokens saved successfully!', 'success');

    // Trigger connection asynchronously
    connectToCentrifugo();

    // Redirect user back to the app dashboard
    res.send(`
      <html>
        <body style="font-family: sans-serif; background: #0f0c1b; color: #fff; text-align: center; padding-top: 50px;">
          <h2>Авторизация успешна!</h2>
          <p>Вы можете закрыть эту вкладку и вернуться в панель управления.</p>
          <script>
            setTimeout(() => { window.close(); }, 3000);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    addLog(`OAuth callback failed: ${err.message}`, 'error');
    res.status(500).send(`Authentication error: ${err.message}`);
  }
});

async function connectOBS(config) {
  if (config.obs && config.obs.address) {
    try {
      await obs.connect(config.obs.address, config.obs.password);
      obsConnected = true;
      addLog('Connected to OBS WebSocket', 'success');
    } catch (err) {
      addLog(`Failed to connect to OBS: ${err.message}`, 'warning');
    }
  }
}

// Start server and connect if already authenticated
server.listen(PORT, () => {
  console.log(`Donation PC Actions hub running at http://localhost:${PORT}`);
  
  // Compile helper executables on startup if missing
  const commandsDir = path.join(__dirname, 'commands');
  if (fs.existsSync(commandsDir)) {
    const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    
    // Compile InvertMouse if missing
    const invertDir = path.join(commandsDir, 'mouse_inversion');
    const invertExe = path.join(invertDir, 'InvertMouse.exe');
    const invertCs = path.join(invertDir, 'InvertMouse.cs');
    if (!fs.existsSync(invertExe) && fs.existsSync(invertCs) && fs.existsSync(cscPath)) {
      console.log('Compiling mouse_inversion/InvertMouse.exe...');
      exec(`"${cscPath}" /nologo /out:"${invertExe}" "${invertCs}"`, (err) => {
        if (err) console.error(`InvertMouse compilation failed: ${err.message}`);
        else console.log('InvertMouse.exe compiled successfully.');
      });
    }

    // Compile SetMouseSpeed if missing
    const speedDir = path.join(commandsDir, 'mouse_speed');
    const speedExe = path.join(speedDir, 'SetMouseSpeed.exe');
    const speedCs = path.join(speedDir, 'SetMouseSpeed.cs');
    if (!fs.existsSync(speedExe) && fs.existsSync(speedCs) && fs.existsSync(cscPath)) {
      console.log('Compiling mouse_speed/SetMouseSpeed.exe...');
      exec(`"${cscPath}" /nologo /out:"${speedExe}" "${speedCs}"`, (err) => {
        if (err) console.error(`SetMouseSpeed compilation failed: ${err.message}`);
        else console.log('SetMouseSpeed.exe compiled successfully.');
      });
    }
  }

  const config = loadConfig();
  connectOBS(config);
  
  // Try connecting immediately if config has credentials
  if (config.accessToken) {
    connectToCentrifugo();
  }
});
