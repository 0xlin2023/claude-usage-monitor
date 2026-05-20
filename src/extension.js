const vscode = require('vscode');
const https = require('https');

/** @type {vscode.StatusBarItem} */
let statusBarItem;
/** @type {NodeJS.Timeout | undefined} */
let refreshTimer;
/** @type {vscode.Memento | undefined} */
let globalState;
/** @type {vscode.SecretStorage | undefined} */
let secretStorage;
/** @type {vscode.OutputChannel} */
let outputChannel;

let lastUsageData = null;
let lastError = null;

// ============================================================
// Activation
// ============================================================

function activate(context) {
  globalState = context.globalState;
  secretStorage = context.secrets;
  outputChannel = vscode.window.createOutputChannel('Claude Usage');

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claude-usage.showDetail';
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    outputChannel,
    vscode.commands.registerCommand('claude-usage.refresh', () => refreshUsage(true)),
    vscode.commands.registerCommand('claude-usage.setUsage', () => setManualUsage()),
    vscode.commands.registerCommand('claude-usage.showDetail', () => showDetail()),
    vscode.commands.registerCommand('claude-usage.setSessionKey', () => setSessionKey()),
    vscode.commands.registerCommand('claude-usage.selectMode', () => selectMode()),
  );

  // Restore saved data
  const saved = globalState.get('usageData');
  if (saved) {
    lastUsageData = saved;
    updateStatusBar(saved);
  } else {
    statusBarItem.text = '$(gear) Claude: Click to Setup';
    statusBarItem.tooltip = 'Click to set your Claude usage';
  }

  startAutoRefresh(context);
}

function startAutoRefresh(context) {
  if (refreshTimer) clearInterval(refreshTimer);
  const config = vscode.workspace.getConfiguration('claudeUsage');
  const sec = config.get('refreshInterval', 300);
  refreshTimer = setInterval(() => refreshUsage(false), sec * 1000);
  if (context) {
    context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });
  }
}

// ============================================================
// Status bar display
// ============================================================

function updateStatusBar(data) {
  const config = vscode.workspace.getConfiguration('claudeUsage');
  const warnAt = config.get('warningThreshold', 80);
  const critAt = config.get('criticalThreshold', 95);

  // For auto mode, use five_hour utilization as the primary indicator
  const pct = data.fiveHour ? Math.round(data.fiveHour.utilization) :
              (data.limit > 0 ? Math.round((data.used / data.limit) * 100) : 0);

  let icon, bg;
  if (pct >= critAt) {
    icon = '$(error)';
    bg = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (pct >= warnAt) {
    icon = '$(warning)';
    bg = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else {
    icon = '$(check)';
    bg = undefined;
  }

  if (data.source === 'auto') {
    statusBarItem.text = `${icon} Claude: ${pct}% used`;
  } else if (data.mode === 'subscription') {
    statusBarItem.text = `${icon} Claude: ${data.remaining}/${data.limit} msgs`;
  } else if (data.mode === 'api') {
    statusBarItem.text = `${icon} Claude: $${fmtDollar(data.remaining)}/$${fmtDollar(data.limit)}`;
  } else {
    statusBarItem.text = `${icon} Claude: ${100 - pct}% left`;
  }

  statusBarItem.backgroundColor = bg;
  statusBarItem.tooltip = buildTooltip(data, pct);
}

function buildTooltip(data, pct) {
  const lines = [];

  if (data.source === 'auto') {
    // Show both time windows
    if (data.fiveHour) {
      lines.push(`5h window: ${Math.round(data.fiveHour.utilization)}% used`);
      const r5 = timeRemaining(data.fiveHour.resetsAt);
      if (r5) lines.push(`  resets in ${r5}`);
    }
    if (data.sevenDay) {
      lines.push(`7d window: ${Math.round(data.sevenDay.utilization)}% used`);
      const r7 = timeRemaining(data.sevenDay.resetsAt);
      if (r7) lines.push(`  resets in ${r7}`);
    }
    if (data.extraUsage) {
      lines.push(`Extra: $${(data.extraUsage.usedCredits / 100).toFixed(2)} / $${(data.extraUsage.monthlyLimit / 100).toFixed(2)}`);
    }
    lines.push(`Plan: ${data.plan}`);
  } else {
    lines.push(`Usage: ${pct}%`);
    if (data.resetAt) {
      const r = timeRemaining(data.resetAt);
      if (r) lines.push(`Resets in: ${r}`);
    }
  }

  if (data.updatedAt) {
    lines.push(`Updated: ${new Date(data.updatedAt).toLocaleTimeString()}`);
  }
  lines.push('', 'Click for details');
  return lines.join('\n');
}

function timeRemaining(dateStr) {
  if (!dateStr) return null;
  const diffMs = new Date(dateStr) - new Date();
  if (diffMs <= 0) return null;
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function fmtDollar(cents) {
  return (cents / 100).toFixed(2);
}

function log(msg) {
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ============================================================
// Refresh usage
// ============================================================

async function refreshUsage(showErrors) {
  const sessionKey = await secretStorage.get('claude-session-key');
  if (!sessionKey) {
    if (lastUsageData) {
      updateStatusBar(lastUsageData);
    }
    return;
  }

  statusBarItem.text = '$(sync~spin) Claude: refreshing...';
  log('Fetching usage from claude.ai...');

  try {
    const data = await fetchFromClaude(sessionKey);
    lastUsageData = data;
    lastError = null;
    await globalState.update('usageData', data);
    updateStatusBar(data);
    log('Usage updated successfully');
    if (showErrors) {
      vscode.window.showInformationMessage('Claude usage refreshed!');
    }
  } catch (err) {
    lastError = err.message;
    log(`Fetch failed: ${err.message}`);

    if (showErrors) {
      const action = await vscode.window.showErrorMessage(
        `Failed to fetch Claude usage: ${err.message}`,
        'Set Manually', 'View Log', 'Retry'
      );
      if (action === 'Set Manually') setManualUsage();
      else if (action === 'View Log') outputChannel.show();
      else if (action === 'Retry') refreshUsage(true);
    }

    // Show stale data if available
    if (lastUsageData) {
      updateStatusBar(lastUsageData);
      statusBarItem.tooltip += `\n\nAuto-refresh failed: ${err.message}`;
    } else {
      statusBarItem.text = '$(error) Claude: Fetch Failed';
      statusBarItem.tooltip = `${err.message}\nClick to set manually`;
    }
  }
}

// ============================================================
// Fetch from Claude.ai
// ============================================================

function httpGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', e => reject(new Error(`Network error: ${e.message}`)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function fetchFromClaude(sessionKey) {
  const headers = {
    'Cookie': `sessionKey=${sessionKey}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  // Step 1: Get org ID and plan info
  log('Fetching /api/organizations ...');
  const orgRes = await httpGet('claude.ai', '/api/organizations', headers);

  if (orgRes.status === 403 || orgRes.status === 401) {
    throw new Error('Session key expired or invalid');
  }
  if (orgRes.status !== 200) {
    throw new Error(`Organizations API returned ${orgRes.status}`);
  }

  const orgs = JSON.parse(orgRes.body);
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error('No organizations found');
  }

  const org = orgs[0];
  const orgId = org.uuid;

  // Detect plan from capabilities
  const caps = org.capabilities || [];
  let plan = 'Free';
  if (caps.includes('claude_max')) plan = 'Max';
  else if (caps.includes('claude_pro')) plan = 'Pro';

  log(`Org: ${org.name}, plan: ${plan}, billing: ${org.billing_type}`);

  // Step 2: Fetch usage
  log('Fetching usage ...');
  const usageRes = await httpGet('claude.ai', `/api/organizations/${orgId}/usage`, headers);

  if (usageRes.status !== 200) {
    throw new Error(`Usage API returned ${usageRes.status}`);
  }

  const usage = JSON.parse(usageRes.body);
  log(`Usage data: ${JSON.stringify(usage, null, 2)}`);

  // Build structured data from real API response
  const data = {
    source: 'auto',
    plan,
    updatedAt: new Date().toISOString(),
    // Primary: 5-hour rate limit window
    fiveHour: usage.five_hour ? {
      utilization: usage.five_hour.utilization,
      resetsAt: usage.five_hour.resets_at,
    } : null,
    // Secondary: 7-day rate limit window
    sevenDay: usage.seven_day ? {
      utilization: usage.seven_day.utilization,
      resetsAt: usage.seven_day.resets_at,
    } : null,
    // Extra usage (overage billing)
    extraUsage: usage.extra_usage ? {
      enabled: usage.extra_usage.is_enabled,
      monthlyLimit: usage.extra_usage.monthly_limit,
      usedCredits: usage.extra_usage.used_credits,
      utilization: usage.extra_usage.utilization,
      currency: usage.extra_usage.currency,
    } : null,
  };

  return data;
}

// ============================================================
// User interactions
// ============================================================

async function selectMode() {
  const pick = await vscode.window.showQuickPick([
    { label: '$(account) Subscription Mode', description: 'Pro/Max - track message count', value: 'subscription' },
    { label: '$(credit-card) API Mode', description: 'API - track dollar spend', value: 'api' },
  ], { title: 'Select Tracking Mode' });

  if (pick) {
    await globalState.update('trackingMode', pick.value);
    setManualUsage(pick.value);
  }
}

async function setSessionKey() {
  const info = await vscode.window.showInformationMessage(
    'To get your sessionKey: Open claude.ai in browser -> F12 -> Application -> Cookies -> copy "sessionKey" value',
    'I have it, paste now', 'Cancel'
  );
  if (info !== 'I have it, paste now') return;

  const key = await vscode.window.showInputBox({
    prompt: 'Paste your sessionKey cookie value here',
    password: true,
    placeHolder: 'sk-ant-sid01-...',
    ignoreFocusOut: true,
  });
  if (!key) return;

  await secretStorage.store('claude-session-key', key.trim());
  vscode.window.showInformationMessage('Session key saved! Fetching usage...');
  refreshUsage(true);
}

async function setManualUsage(forcedMode) {
  const mode = forcedMode || globalState.get('trackingMode') || 'subscription';

  if (mode === 'subscription') {
    const usedStr = await vscode.window.showInputBox({
      prompt: 'How many messages have you used?',
      placeHolder: 'e.g. 25',
      ignoreFocusOut: true,
    });
    if (!usedStr) return;

    const limitStr = await vscode.window.showInputBox({
      prompt: 'What is your message limit?',
      placeHolder: 'e.g. 45 (Pro) or 225 (Max)',
      ignoreFocusOut: true,
    });
    if (!limitStr) return;

    const resetHours = await vscode.window.showInputBox({
      prompt: 'Hours until reset? (leave empty to skip)',
      placeHolder: 'e.g. 5',
      ignoreFocusOut: true,
    });

    const used = parseInt(usedStr, 10);
    const limit = parseInt(limitStr, 10);
    if (isNaN(used) || isNaN(limit)) {
      vscode.window.showErrorMessage('Please enter valid numbers.');
      return;
    }

    const resetAt = resetHours && !isNaN(parseInt(resetHours))
      ? new Date(Date.now() + parseInt(resetHours) * 3600000).toISOString()
      : null;

    const data = {
      mode: 'subscription', used, limit,
      remaining: limit - used, resetAt,
      plan: 'manual',
      updatedAt: new Date().toISOString(),
    };

    lastUsageData = data;
    lastError = null;
    await globalState.update('usageData', data);
    updateStatusBar(data);
    vscode.window.showInformationMessage(`Claude: ${data.remaining}/${limit} messages remaining`);

  } else {
    const usedStr = await vscode.window.showInputBox({
      prompt: 'Amount spent (dollars)',
      placeHolder: 'e.g. 12.50',
      ignoreFocusOut: true,
    });
    if (!usedStr) return;

    const limitStr = await vscode.window.showInputBox({
      prompt: 'Spending limit (dollars)',
      placeHolder: 'e.g. 100',
      ignoreFocusOut: true,
    });
    if (!limitStr) return;

    const used = Math.round(parseFloat(usedStr) * 100);
    const limit = Math.round(parseFloat(limitStr) * 100);
    if (isNaN(used) || isNaN(limit)) {
      vscode.window.showErrorMessage('Please enter valid numbers.');
      return;
    }

    const data = {
      mode: 'api', used, limit,
      remaining: limit - used, resetAt: null,
      plan: 'api',
      updatedAt: new Date().toISOString(),
    };

    lastUsageData = data;
    lastError = null;
    await globalState.update('usageData', data);
    updateStatusBar(data);
    vscode.window.showInformationMessage(`Claude: $${fmtDollar(data.remaining)} remaining`);
  }
}

async function showDetail() {
  // If no data yet, go straight to setup
  if (!lastUsageData) {
    const pick = await vscode.window.showQuickPick([
      { label: '$(edit) Set Usage Manually', description: 'Quick: enter your current usage', action: 'manual' },
      { label: '$(key) Set Session Key', description: 'Auto: fetch from claude.ai', action: 'session' },
    ], { title: 'Claude Usage - First Time Setup', placeHolder: 'Choose how to track usage' });

    if (pick?.action === 'manual') setManualUsage();
    else if (pick?.action === 'session') setSessionKey();
    return;
  }

  const items = [];
  const d = lastUsageData;

  if (d.source === 'auto') {
    items.push({ label: `$(tag) Plan: ${d.plan}`, description: '' });

    if (d.fiveHour) {
      const r = timeRemaining(d.fiveHour.resetsAt);
      items.push({
        label: `$(dashboard) 5h window: ${Math.round(d.fiveHour.utilization)}% used`,
        description: r ? `resets in ${r}` : '',
      });
    }
    if (d.sevenDay) {
      const r = timeRemaining(d.sevenDay.resetsAt);
      items.push({
        label: `$(calendar) 7d window: ${Math.round(d.sevenDay.utilization)}% used`,
        description: r ? `resets in ${r}` : '',
      });
    }
    if (d.extraUsage) {
      items.push({
        label: `$(credit-card) Extra usage: $${(d.extraUsage.usedCredits / 100).toFixed(2)} / $${(d.extraUsage.monthlyLimit / 100).toFixed(2)}`,
        description: `${Math.round(d.extraUsage.utilization)}%`,
      });
    }
  } else if (d.mode === 'subscription') {
    const pct = d.limit > 0 ? Math.round((d.used / d.limit) * 100) : 0;
    items.push(
      { label: `$(pulse) Used: ${d.used} / ${d.limit} messages`, description: `${pct}%` },
      { label: `$(dashboard) Remaining: ${d.remaining} messages` },
    );
    if (d.resetAt) {
      const r = timeRemaining(d.resetAt);
      if (r) items.push({ label: `$(clock) Resets in: ${r}` });
    }
  } else if (d.mode === 'api') {
    const pct = d.limit > 0 ? Math.round((d.used / d.limit) * 100) : 0;
    items.push(
      { label: `$(pulse) Spent: $${fmtDollar(d.used)} / $${fmtDollar(d.limit)}`, description: `${pct}%` },
      { label: `$(dashboard) Remaining: $${fmtDollar(d.remaining)}` },
    );
  }

  if (d.updatedAt) items.push({ label: `$(history) Updated: ${new Date(d.updatedAt).toLocaleString()}` });

  if (lastError) {
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: `$(error) Last error: ${lastError}` });
  }

  items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push(
    { label: '$(refresh) Refresh Now', action: 'refresh' },
    { label: '$(edit) Set Usage Manually', action: 'manual' },
    { label: '$(key) Set Session Key', action: 'session' },
    { label: '$(settings-gear) Change Tracking Mode', action: 'mode' },
    { label: '$(output) View Log', action: 'log' },
  );

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Claude Usage Monitor',
    placeHolder: 'Usage details & actions',
  });

  if (!pick?.action) return;
  switch (pick.action) {
    case 'refresh': refreshUsage(true); break;
    case 'manual': setManualUsage(); break;
    case 'session': setSessionKey(); break;
    case 'mode': selectMode(); break;
    case 'log': outputChannel.show(); break;
  }
}

function deactivate() {
  if (refreshTimer) clearInterval(refreshTimer);
}

module.exports = { activate, deactivate };
