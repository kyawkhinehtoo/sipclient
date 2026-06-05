<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { SessionState } from 'sip.js';
import sipService from '@/services/sipService.js';
import configStore from '@/services/configStore.js';
import {
  buildTransferTeam,
  loadTransferTeams,
  normalizeTransferTeams,
  saveTransferTeams,
} from '@/services/transferTeamsStore.js';
import callTonePlayer from '@/services/callTonePlayer.js';
import { formatCallEndStatus } from '@/services/callStatusText.js';
import callHistoryStore from '@/services/callHistoryStore.js';
import {
  directionSummary,
  formatCallDuration,
  formatHistoryTimestamp,
  historyStatusLabel,
  outcomeBadgeClass,
  outcomeLabel,
  resolveCallOutcome,
} from '@/services/callHistoryText.js';
import {
  appName,
  appTagline,
  isUcmHostFromEnv,
  isUcmWsPortFromEnv,
  ucmHost,
  ucmWsPort,
} from '@/config/appEnv.js';

/** @typedef {'disconnected' | 'registered' | 'calling' | 'incall' | 'connected'} ConnectionStatus */

const DIAL_PAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

const serverIp = ref('');
const extension = ref('');
const password = ref('');
const localIpOverride = ref('');
const preferLanIp = ref(false);
const wsPort = ref(8089);
const targetExtension = ref('');
const rememberConfig = ref(true);
const autoLogin = ref(false);

const isLoggedIn = ref(false);
const isBootstrapping = ref(true);
/** @type {import('vue').Ref<ConnectionStatus>} */
const connectionStatus = ref('disconnected');
const callerId = ref('');
const registerError = ref('');
const callEndMessage = ref('');
const isLoggingIn = ref(false);
const isAnswering = ref(false);
const registeredEndpoint = ref('');

const remoteAudio = ref(null);
/** @type {import('vue').Ref<import('sip.js').Session | null>} */
const activeSessionRef = ref(null);
/** Bumps when sip.js session state changes so computeds re-run. */
const sessionStateVersion = ref(0);

/** @type {import('vue').Ref<import('@/services/transferTeamsStore.js').TransferTeam[]>} */
const transferTeams = ref([]);

const showLoginAdvanced = ref(false);
const showTransferSettings = ref(false);
const showCallHistory = ref(false);
/** @type {import('vue').Ref<import('@/services/callHistoryStore.js').CallHistoryEntry[]>} */
const callHistoryEntries = ref([]);
const callHistoryFilter = ref('all');
const missedCallsCount = ref(0);
const isLoadingCallHistory = ref(false);
/** @type {import('vue').Ref<{ direction: 'inbound' | 'outbound', remoteParty: string, startedAt: string, wasEstablished: boolean } | null>} */
const activeCallMeta = ref(null);
const newTeamName = ref('');
const newTeamCode = ref('');
const teamFormError = ref('');
const isMuted = ref(false);
const isOnHold = ref(false);
const isHoldPending = ref(false);
/** Starting consultation INVITE to transfer target. */
const isTransferring = ref(false);
/** @type {import('vue').Ref<import('@/services/transferTeamsStore.js').TransferTeam | null>} */
const attendedTransferTeam = ref(null);
/** Customer display id saved when consultation starts (restored on cancel). */
const customerCallerId = ref('');

const callDurationSeconds = ref(0);
let callDurationTimer = null;
let callEndMessageTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let outboundCallWatchTimer = null;

const showLoginForm = computed(() => !isLoggedIn.value);

const isInCallFlow = computed(() =>
  ['calling', 'incall', 'connected'].includes(connectionStatus.value),
);

const sipSessionState = computed(() => {
  sessionStateVersion.value;
  return activeSessionRef.value?.state ?? null;
});

const canCall = computed(
  () =>
    isLoggedIn.value &&
    connectionStatus.value === 'registered' &&
    !isInCallFlow.value &&
    targetExtension.value.trim().length > 0,
);


/** True while outbound, connected, or ringing with an active SIP session. */
const hasActiveSession = computed(() => {
  sessionStateVersion.value;
  return Boolean(activeSessionRef.value ?? sipService.currentSession);
});

const showIdleDialer = computed(
  () => isLoggedIn.value && !hasActiveSession.value && !showCallHistory.value,
);

const showIdleCallHistory = computed(
  () => isLoggedIn.value && !hasActiveSession.value && showCallHistory.value,
);

const filteredCallHistoryEmpty = computed(
  () => !isLoadingCallHistory.value && callHistoryEntries.value.length === 0,
);

const isInTransferConsultation = computed(() => {
  sessionStateVersion.value;
  return Boolean(sipService.consultationSession && sipService.primarySessionForTransfer);
});

const isStartingConsultation = computed(() => isTransferring.value);

const transferStatusMessage = computed(() => {
  const team = attendedTransferTeam.value;
  if (!team) {
    return '';
  }
  if (isStartingConsultation.value) {
    return `Calling ${team.name} (${team.extension})…`;
  }
  if (isInTransferConsultation.value) {
    if (sipSessionState.value === SessionState.Establishing) {
      return `Ringing ${team.name}…`;
    }
    return `Consulting with ${team.name} (${team.extension}) — customer on hold`;
  }
  return '';
});

const canCompleteAttendedTransfer = computed(() => {
  sessionStateVersion.value;
  return (
    isInTransferConsultation.value && sipSessionState.value === SessionState.Established
  );
});

const callControlsDisabled = computed(
  () => isStartingConsultation.value || isAnswering.value || isHoldPending.value,
);

const showIncomingOverlay = computed(() => connectionStatus.value === 'incall');

const callDurationDisplay = computed(() => {
  const minutes = Math.floor(callDurationSeconds.value / 60);
  const seconds = callDurationSeconds.value % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
});

const activeCallStatusLine = computed(() => {
  if (isInTransferConsultation.value) {
    const teamName = attendedTransferTeam.value?.name ?? 'transfer target';
    if (sipSessionState.value === SessionState.Establishing) {
      return `Calling ${teamName}…`;
    }
    return `Consultation • ${callDurationDisplay.value}`;
  }

  if (connectionStatus.value === 'connected') {
    if (isOnHold.value) {
      return `On hold • ${callDurationDisplay.value}`;
    }
    return `Connected • ${callDurationDisplay.value}`;
  }

  if (connectionStatus.value === 'calling') {
    const ringing = sipSessionState.value === SessionState.Establishing;
    return ringing ? 'Ringing…' : `Dialing • ${callDurationDisplay.value}`;
  }

  if (connectionStatus.value === 'incall') {
    return `Incoming • ${callerId.value || 'Unknown'}`;
  }

  return 'In call';
});

const canUseSessionMediaControls = computed(() => connectionStatus.value === 'connected');

const canAddTransferTeam = computed(
  () => newTeamName.value.trim().length > 0 && newTeamCode.value.trim().length > 0,
);

const headerPresence = computed(() => {
  if (!isLoggedIn.value) {
    return { label: '', dotClass: 'bg-slate-500', textClass: 'text-slate-400', showPing: false };
  }

  if (isLoggingIn.value) {
    return {
      label: 'Connecting…',
      dotClass: 'bg-amber-500',
      textClass: 'text-amber-400',
      showPing: false,
    };
  }

  if (isInTransferConsultation.value) {
    return {
      label: 'Consultation',
      dotClass: 'bg-violet-500',
      textClass: 'text-violet-400',
      showPing: false,
    };
  }

  if (connectionStatus.value === 'connected') {
    return {
      label: isOnHold.value ? 'On hold' : 'In call',
      dotClass: isOnHold.value ? 'bg-sky-500' : 'bg-emerald-500',
      textClass: isOnHold.value ? 'text-sky-400' : 'text-emerald-400',
      showPing: false,
    };
  }

  if (connectionStatus.value === 'calling') {
    const ringing = sipSessionState.value === SessionState.Establishing;
    return {
      label: ringing ? 'Ringing' : 'Dialing',
      dotClass: 'bg-amber-500',
      textClass: 'text-amber-400',
      showPing: false,
    };
  }

  if (connectionStatus.value === 'incall') {
    return {
      label: 'Incoming',
      dotClass: 'bg-sky-500',
      textClass: 'text-sky-400',
      showPing: false,
    };
  }

  if (connectionStatus.value === 'registered') {
    return {
      label: 'Online',
      dotClass: 'bg-emerald-500',
      textClass: 'text-emerald-400',
      showPing: true,
    };
  }

  return {
    label: 'Offline',
    dotClass: 'bg-slate-500',
    textClass: 'text-slate-400',
    showPing: false,
  };
});

const showStatusPing = computed(() => headerPresence.value.showPing);

function applyEnvServerDefaults() {
  if (isUcmHostFromEnv) {
    serverIp.value = ucmHost;
  }
  if (isUcmWsPortFromEnv) {
    wsPort.value = ucmWsPort;
  }
}

function applyConfigToForm(config) {
  if (!isUcmHostFromEnv) {
    serverIp.value = config.serverIp ?? '';
  }
  extension.value = config.extension ?? '';
  password.value = config.password ?? '';
  localIpOverride.value = config.localIp ?? '';
  preferLanIp.value = Boolean(config.preferLanIp);
  if (!isUcmWsPortFromEnv) {
    wsPort.value = config.wsPort ?? 8089;
  }
  rememberConfig.value = config.rememberConfig !== false;
  autoLogin.value = Boolean(config.autoLogin);
  if (config.transferTeams?.length) {
    transferTeams.value = normalizeTransferTeams(config.transferTeams);
  }
}

function currentServerConfigPayload() {
  return {
    serverIp: serverIp.value.trim(),
    extension: extension.value.trim(),
    password: password.value,
    localIp: localIpOverride.value.trim(),
    preferLanIp: preferLanIp.value,
    wsPort: Number(wsPort.value) || 8089,
    rememberConfig: rememberConfig.value,
    autoLogin: autoLogin.value,
    transferTeams: transferTeams.value,
  };
}

async function persistTransferTeams() {
  transferTeams.value = await saveTransferTeams(
    transferTeams.value,
    currentServerConfigPayload(),
  );
}

async function handleAddTransferTeam() {
  teamFormError.value = '';
  const name = newTeamName.value.trim();
  const code = newTeamCode.value.trim();

  if (!name || !code) {
    teamFormError.value = 'Enter a team name and transfer code.';
    return;
  }

  if (transferTeams.value.some((team) => team.extension === code)) {
    teamFormError.value = `Transfer code ${code} is already registered.`;
    return;
  }

  transferTeams.value = [
    ...transferTeams.value,
    buildTransferTeam(name, code, transferTeams.value.length),
  ];
  newTeamName.value = '';
  newTeamCode.value = '';

  try {
    await persistTransferTeams();
  } catch (error) {
    teamFormError.value = error?.message ?? 'Could not save transfer team.';
  }
}

async function handleRemoveTransferTeam(teamId) {
  teamFormError.value = '';
  transferTeams.value = transferTeams.value.filter((team) => team.id !== teamId);

  try {
    await persistTransferTeams();
  } catch (error) {
    teamFormError.value = error?.message ?? 'Could not update transfer teams.';
  }
}

function startCallTimer() {
  stopCallTimer();
  callDurationSeconds.value = 0;
  callDurationTimer = setInterval(() => {
    callDurationSeconds.value += 1;
  }, 1000);
}

function stopCallTimer() {
  if (callDurationTimer !== null) {
    clearInterval(callDurationTimer);
    callDurationTimer = null;
  }
}

function showCallEndFeedback(statusCode, reasonPhrase) {
  if (callEndMessageTimer !== null) {
    clearTimeout(callEndMessageTimer);
  }

  const text = formatCallEndStatus(statusCode, reasonPhrase) || 'Call ended';
  callEndMessage.value = text;

  callEndMessageTimer = setTimeout(() => {
    callEndMessage.value = '';
    callEndMessageTimer = null;
  }, 3000);
}

function bindSessionStateListener(session) {
  if (!session) {
    return;
  }

  activeSessionRef.value = session;
  session.stateChange.addListener(onSessionStateChange);
}

function stopOutboundCallWatch() {
  if (outboundCallWatchTimer !== null) {
    clearInterval(outboundCallWatchTimer);
    outboundCallWatchTimer = null;
  }
}

function startOutboundCallWatch(session) {
  stopOutboundCallWatch();

  outboundCallWatchTimer = setInterval(() => {
    if (connectionStatus.value !== 'calling') {
      stopOutboundCallWatch();
      return;
    }

    const sessionGone =
      !session ||
      session.state === SessionState.Terminated ||
      sipService.currentSession !== session;

    if (sessionGone) {
      const end = sipService.lastCallEnd ?? {};
      finishCall(end.statusCode, end.reasonPhrase);
    }
  }, 250);
}

async function refreshCallHistory() {
  if (!callHistoryStore.isAvailable()) {
    callHistoryEntries.value = [];
    missedCallsCount.value = 0;
    return;
  }

  isLoadingCallHistory.value = true;
  try {
    const [entries, missed] = await Promise.all([
      callHistoryStore.list(callHistoryFilter.value),
      callHistoryStore.missedCount(),
    ]);
    callHistoryEntries.value = entries;
    missedCallsCount.value = missed;
  } catch (error) {
    console.error('[Softphone] load call history:', error);
  } finally {
    isLoadingCallHistory.value = false;
  }
}

function beginCallTracking(direction, remoteParty) {
  if (sipService.consultationSession || sipService.primarySessionForTransfer) {
    return;
  }

  activeCallMeta.value = {
    direction,
    remoteParty: String(remoteParty ?? '').trim() || 'Unknown',
    startedAt: new Date().toISOString(),
    wasEstablished: false,
  };
}

async function persistCallHistoryEntry(statusCode, reasonPhrase) {
  const meta = activeCallMeta.value;
  activeCallMeta.value = null;

  if (!meta || !callHistoryStore.isAvailable()) {
    return;
  }

  const outcome = resolveCallOutcome(meta, statusCode, reasonPhrase);
  const statusLabel = historyStatusLabel(statusCode, reasonPhrase);

  try {
    await callHistoryStore.add({
      direction: meta.direction,
      remoteParty: meta.remoteParty,
      outcome,
      durationSeconds: callDurationSeconds.value,
      statusCode,
      statusLabel,
      startedAt: meta.startedAt,
      endedAt: new Date().toISOString(),
    });
    await refreshCallHistory();
  } catch (error) {
    console.error('[Softphone] save call history:', error);
  }
}

function toggleCallHistoryPanel() {
  showTransferSettings.value = false;
  showCallHistory.value = !showCallHistory.value;
  if (showCallHistory.value) {
    void refreshCallHistory();
  }
}

function toggleTransferSettingsPanel() {
  showCallHistory.value = false;
  showTransferSettings.value = !showTransferSettings.value;
}

async function handleCallHistoryFilterChange(filter) {
  callHistoryFilter.value = filter;
  await refreshCallHistory();
}

async function handleClearCallHistory() {
  if (!callHistoryStore.isAvailable()) {
    return;
  }

  try {
    await callHistoryStore.clear();
    callHistoryEntries.value = [];
    missedCallsCount.value = 0;
  } catch (error) {
    registerError.value = error?.message ?? 'Could not clear call history.';
  }
}

function handleHistoryDial(entry) {
  if (!entry?.remoteParty || hasActiveSession.value) {
    return;
  }

  showCallHistory.value = false;
  targetExtension.value = entry.remoteParty;
  registerError.value = '';
}

function finishCall(statusCode, reasonPhrase) {
  void persistCallHistoryEntry(statusCode, reasonPhrase);

  stopCallTimer();
  stopOutboundCallWatch();
  callTonePlayer.stop();

  if (activeSessionRef.value) {
    activeSessionRef.value.stateChange.removeListener(onSessionStateChange);
    activeSessionRef.value = null;
  }

  callerId.value = '';
  isMuted.value = false;
  isOnHold.value = false;
  isHoldPending.value = false;
  isTransferring.value = false;
  attendedTransferTeam.value = null;
  customerCallerId.value = '';
  connectionStatus.value = 'registered';
  showCallEndFeedback(statusCode, reasonPhrase);
}

function resetCallUi() {
  finishCall(undefined, undefined);
}

function onSessionStateChange(newState) {
  sessionStateVersion.value += 1;

  if (newState === SessionState.Establishing && connectionStatus.value === 'calling') {
    callTonePlayer.stop();
  }

  if (newState === SessionState.Established) {
    callTonePlayer.stop();
    connectionStatus.value = 'connected';
    registerError.value = '';
    if (activeCallMeta.value) {
      activeCallMeta.value = { ...activeCallMeta.value, wasEstablished: true };
    }
    startCallTimer();
  }

  if (newState === SessionState.Terminated) {
    queueMicrotask(() => {
      if (
        sipService.primarySessionForTransfer &&
        session === sipService.consultationSession
      ) {
        const primary = sipService.primarySessionForTransfer;
        if (primary && primary.state !== SessionState.Terminated) {
          bindSessionStateListener(primary);
          callerId.value = customerCallerId.value;
          attendedTransferTeam.value = null;
          connectionStatus.value = 'connected';
          isOnHold.value = true;
          isMuted.value = false;
          registerError.value = 'Consultation ended. Customer is still on hold.';
          return;
        }
      }

      const end = sipService.lastCallEnd ?? {};
      finishCall(end.statusCode, end.reasonPhrase);
    });
  }
}

function appendDigit(digit) {
  targetExtension.value += digit;
}

function backspaceDigit() {
  targetExtension.value = targetExtension.value.slice(0, -1);
}

async function persistConfigIfNeeded() {
  if (!configStore.isAvailable() || !rememberConfig.value) {
    return;
  }

  await configStore.save({
    ...currentServerConfigPayload(),
    rememberConfig: true,
  });
}

function handleLoginSubmit() {
  if (isLoggingIn.value || !serverIp.value?.trim() || !extension.value.trim() || !password.value) {
    return;
  }
  void handleLogin();
}

async function handleLogin() {
  registerError.value = '';
  isLoggingIn.value = true;
  connectionStatus.value = 'disconnected';

  try {
    await callTonePlayer.warmup();
    await persistConfigIfNeeded();

    await sipService.initialize({
      serverIp: serverIp.value.trim(),
      extension: extension.value.trim(),
      password: password.value,
      wsPort: Number(wsPort.value) || 8089,
      localIp: localIpOverride.value.trim() || undefined,
      preferLanIp: preferLanIp.value,
    });
  } catch (error) {
    isLoggedIn.value = false;
    connectionStatus.value = 'disconnected';
    registerError.value = error?.message ?? 'Login failed.';
    await sipService.shutdown().catch(() => {});
  } finally {
    if (!isLoggedIn.value) {
      isLoggingIn.value = false;
    }
  }
}

async function handleLogout() {
  registerError.value = '';
  callTonePlayer.stop();
  stopCallTimer();

  try {
    if (isInCallFlow.value) {
      await sipService.hangUp();
    }
    await sipService.shutdown();
  } catch (error) {
    console.error('[Softphone] logout:', error);
  } finally {
    if (activeSessionRef.value) {
      activeSessionRef.value.stateChange.removeListener(onSessionStateChange);
      activeSessionRef.value = null;
    }
    isLoggedIn.value = false;
    isLoggingIn.value = false;
    connectionStatus.value = 'disconnected';
    registeredEndpoint.value = '';
    callerId.value = '';
    showTransferSettings.value = false;
  }
}

async function handleForgetConfig() {
  await configStore.clear();
  if (!isUcmHostFromEnv) {
    serverIp.value = '';
  } else {
    applyEnvServerDefaults();
  }
  extension.value = '';
  password.value = '';
  localIpOverride.value = '';
  preferLanIp.value = false;
  rememberConfig.value = true;
  autoLogin.value = false;
  registerError.value = '';
  transferTeams.value = await loadTransferTeams();
}

async function handleCall() {
  if (!canCall.value || !remoteAudio.value) return;

  showTransferSettings.value = false;
  registerError.value = '';
  callEndMessage.value = '';
  connectionStatus.value = 'calling';
  sessionStateVersion.value += 1;

  try {
    beginCallTracking('outbound', targetExtension.value.trim());
    await callTonePlayer.startRingback();
    const session = await sipService.makeCall(targetExtension.value.trim(), remoteAudio.value);
    bindSessionStateListener(session);
    startOutboundCallWatch(session);
  } catch (error) {
    activeCallMeta.value = null;
    registerError.value = error?.message ?? 'Call failed.';
    finishCall(undefined, undefined);
  }
}

async function handleHangUp() {
  try {
    await sipService.hangUp();
  } catch (error) {
    console.error('[Softphone] hangUp:', error);
  } finally {
    resetCallUi();
  }
}

function handleToggleMute() {
  if (callControlsDisabled.value) {
    return;
  }

  try {
    const nextMuted = !isMuted.value;
    sipService.setCallMuted(nextMuted);
    isMuted.value = nextMuted;
  } catch (error) {
    registerError.value = error?.message ?? 'Could not change mute state.';
  }
}

async function handleToggleHold() {
  if (callControlsDisabled.value) {
    return;
  }

  registerError.value = '';
  isHoldPending.value = true;
  const nextHold = !isOnHold.value;

  try {
    await sipService.setCallHold(nextHold);
    isOnHold.value = sipService.isCallOnHold();
  } catch (error) {
    isOnHold.value = sipService.isCallOnHold();
    registerError.value = error?.message ?? 'Could not change hold state.';
  } finally {
    isHoldPending.value = false;
  }
}

async function handleQuickTransfer(team) {
  if (
    callControlsDisabled.value ||
    connectionStatus.value !== 'connected' ||
    isInTransferConsultation.value
  ) {
    return;
  }

  if (!remoteAudio.value) {
    registerError.value = 'Audio is not ready. Try again.';
    return;
  }

  registerError.value = '';
  isTransferring.value = true;
  attendedTransferTeam.value = team;
  customerCallerId.value = callerId.value || targetExtension.value || '';

  try {
    const session = await sipService.startAttendedTransfer(team.extension, remoteAudio.value);
    bindSessionStateListener(session);
    callerId.value = team.extension;
    connectionStatus.value =
      session.state === SessionState.Established ? 'connected' : 'calling';
    isOnHold.value = false;
    isMuted.value = false;
    startOutboundCallWatch(session);
  } catch (error) {
    const savedCustomer = customerCallerId.value;
    attendedTransferTeam.value = null;
    customerCallerId.value = '';
    callerId.value = savedCustomer;
    isOnHold.value = sipService.isCallOnHold();
    registerError.value = error?.message ?? 'Could not start consultation call.';
  } finally {
    isTransferring.value = false;
  }
}

async function handleCompleteAttendedTransfer() {
  if (!canCompleteAttendedTransfer.value) {
    return;
  }

  registerError.value = '';
  isTransferring.value = true;

  try {
    await sipService.completeAttendedTransfer();
    resetCallUi();
  } catch (error) {
    registerError.value = error?.message ?? 'Could not complete transfer.';
  } finally {
    isTransferring.value = false;
    attendedTransferTeam.value = null;
    customerCallerId.value = '';
  }
}

async function handleCancelAttendedTransfer() {
  if (!isInTransferConsultation.value && !sipService.primarySessionForTransfer) {
    return;
  }

  registerError.value = '';
  isTransferring.value = true;

  try {
    await sipService.cancelAttendedTransfer();
    const primary = sipService.currentSession;
    if (primary && primary.state !== SessionState.Terminated) {
      bindSessionStateListener(primary);
      callerId.value = customerCallerId.value;
      connectionStatus.value = 'connected';
      isOnHold.value = sipService.isCallOnHold();
      isMuted.value = false;
      registerError.value = '';
    } else {
      resetCallUi();
    }
  } catch (error) {
    registerError.value = error?.message ?? 'Could not cancel transfer.';
  } finally {
    isTransferring.value = false;
    attendedTransferTeam.value = null;
    customerCallerId.value = '';
  }
}

async function handleAccept() {
  if (!remoteAudio.value || isAnswering.value) return;

  registerError.value = '';
  isAnswering.value = true;
  callTonePlayer.stop();

  try {
    await sipService.answerCall(remoteAudio.value);
    if (sipService.currentSession) {
      bindSessionStateListener(sipService.currentSession);
    }
    connectionStatus.value = 'connected';
    startCallTimer();
  } catch (error) {
    connectionStatus.value = 'incall';
    registerError.value = error?.message ?? 'Could not answer call.';
  } finally {
    isAnswering.value = false;
  }
}

async function handleReject() {
  await handleHangUp();
}

function handleIncomingCall(invitation) {
  const remote = invitation.remoteIdentity?.uri?.user ?? 'Unknown';
  callerId.value = remote;
  beginCallTracking('inbound', remote);
  connectionStatus.value = 'incall';
  isAnswering.value = false;
  bindSessionStateListener(invitation);

  window.electronAPI?.focusWindow?.().catch(() => {});
  void callTonePlayer.startRinging();

  if (remoteAudio.value) {
    sipService.bindIncomingRingAudio(invitation, remoteAudio.value);
  }
}

function setupSipCallbacks() {
  sipService.onIncomingCall = handleIncomingCall;
  sipService.onCallEnded = ({ statusCode, reasonPhrase }) => {
    finishCall(statusCode, reasonPhrase);
  };
  sipService.onRegistered = () => {
    isLoggedIn.value = true;
    isLoggingIn.value = false;
    connectionStatus.value = 'registered';
    registerError.value = '';
    registeredEndpoint.value = sipService.localIp ?? '';
    void refreshCallHistory();
  };
  sipService.onUnregistered = () => {
    if (!isInCallFlow.value && isLoggedIn.value) {
      connectionStatus.value = 'registered';
    }
  };
}

async function bootstrapFromStorage() {
  isBootstrapping.value = true;

  try {
    applyEnvServerDefaults();
    const saved = await configStore.load();
    if (saved) {
      applyConfigToForm(saved);
    }
    applyEnvServerDefaults();
    if (!transferTeams.value.length) {
      transferTeams.value = await loadTransferTeams();
    }
    await refreshCallHistory();
    if (saved) {
      if (saved.autoLogin && (saved.serverIp || isUcmHostFromEnv) && saved.extension) {
        if (!saved.password) {
          registerError.value =
            'Auto-login skipped: saved password unavailable. Enter your password and log in.';
        } else {
          await handleLogin();
        }
      }
    }
  } catch (error) {
    registerError.value = error?.message ?? 'Could not load saved settings.';
  } finally {
    isBootstrapping.value = false;
  }
}

onMounted(async () => {
  setupSipCallbacks();
  await bootstrapFromStorage();
});

onBeforeUnmount(() => {
  stopOutboundCallWatch();
  stopCallTimer();
  if (callEndMessageTimer !== null) {
    clearTimeout(callEndMessageTimer);
  }
  callTonePlayer.stop();
  sipService.onIncomingCall = null;
  sipService.onCallEnded = null;
  sipService.onRegistered = null;
  sipService.onUnregistered = null;

  if (activeSessionRef.value) {
    activeSessionRef.value.stateChange.removeListener(onSessionStateChange);
    activeSessionRef.value = null;
  }
});
</script>

<template>
  <div
    class="relative mx-auto flex h-full max-h-[540px] min-h-0 w-full max-w-[380px] flex-col overflow-hidden bg-slate-950 text-slate-100 shadow-2xl"
  >
    <header class="shrink-0 border-b border-slate-800/80 px-3 py-2">
      <div class="flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-sm font-bold text-white">{{ appName }}</h1>
          <p v-if="appTagline" class="truncate text-[10px] text-slate-500">{{ appTagline }}</p>
        </div>

        <div
          v-if="isLoggedIn"
          class="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/80 px-2 py-1"
        >
          <span class="relative flex h-2 w-2 shrink-0">
            <span
              v-if="showStatusPing"
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"
              aria-hidden="true"
            />
            <span
              class="relative inline-flex h-2 w-2 rounded-full"
              :class="headerPresence.dotClass"
              aria-hidden="true"
            />
          </span>
          <span class="text-xs font-medium" :class="headerPresence.textClass">
            {{ headerPresence.label }}
          </span>
        </div>

        <button
          v-if="isLoggedIn"
          type="button"
          class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-150"
          :class="
            showCallHistory
              ? 'border-slate-500 bg-slate-800 text-slate-100'
              : 'border-slate-700/60 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:bg-slate-800/80 hover:text-slate-200'
          "
          :aria-label="showCallHistory ? 'Close call history' : 'Call history'"
          :aria-expanded="showCallHistory"
          @click="toggleCallHistoryPanel"
        >
          <svg
            class="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.75"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span
            v-if="missedCallsCount > 0"
            class="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white"
            aria-hidden="true"
          >
            {{ missedCallsCount > 9 ? '9+' : missedCallsCount }}
          </span>
        </button>

        <button
          v-if="isLoggedIn"
          type="button"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-150"
          :class="
            showTransferSettings
              ? 'border-slate-500 bg-slate-800 text-slate-100'
              : 'border-slate-700/60 bg-slate-900/60 text-slate-400 hover:border-slate-600 hover:bg-slate-800/80 hover:text-slate-200'
          "
          :aria-label="showTransferSettings ? 'Close transfer settings' : 'Manage transfer teams'"
          :aria-expanded="showTransferSettings"
          @click="toggleTransferSettingsPanel"
        >
          <svg
            class="h-4 w-4 transition-transform duration-200"
            :class="showTransferSettings ? 'rotate-90' : ''"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.75"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.003.827c.424.35.534.955.26 1.43l-1.296 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        </button>

        <button
          v-if="isLoggedIn"
          type="button"
          class="shrink-0 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:text-red-300"
          @click="handleLogout"
        >
          Logout
        </button>
      </div>

      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 -translate-y-1"
        enter-to-class="opacity-100 translate-y-0"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100 translate-y-0"
        leave-to-class="opacity-0 -translate-y-1"
      >
        <div
          v-if="showTransferSettings && isLoggedIn"
          class="mt-2 rounded-xl border border-slate-700/80 bg-slate-900/95 p-3 shadow-lg shadow-black/20"
        >
          <div class="mb-2 flex items-center justify-between gap-2">
            <p class="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Transfer teams
            </p>
            <button
              type="button"
              class="text-[10px] text-slate-500 hover:text-slate-300"
              @click="showTransferSettings = false"
            >
              Close
            </button>
          </div>

          <div class="grid grid-cols-2 gap-2">
            <input
              v-model="newTeamName"
              type="text"
              placeholder="Team name"
              class="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-sm text-white placeholder:text-slate-500 outline-none focus:border-emerald-500/60"
            />
            <input
              v-model="newTeamCode"
              type="tel"
              inputmode="tel"
              placeholder="Code"
              class="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-2 text-sm text-white placeholder:text-slate-500 outline-none focus:border-emerald-500/60"
            />
          </div>
          <button
            type="button"
            class="mt-2 w-full rounded-lg bg-slate-700 py-2 text-xs font-semibold text-white transition hover:bg-slate-600 disabled:opacity-40"
            :disabled="!canAddTransferTeam"
            @click="handleAddTransferTeam"
          >
            Add team
          </button>
          <p v-if="teamFormError" class="mt-1.5 text-xs text-red-400">{{ teamFormError }}</p>

          <ul v-if="transferTeams.length" class="mt-2 max-h-28 space-y-1.5 overflow-y-auto">
            <li
              v-for="team in transferTeams"
              :key="team.id"
              class="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/80 px-2.5 py-1.5"
            >
              <span class="h-2 w-2 shrink-0 rounded-full" :class="team.color" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="truncate text-xs font-semibold text-white">{{ team.name }}</p>
                <p class="font-mono text-[10px] text-slate-500">{{ team.extension }}</p>
              </div>
              <button
                type="button"
                class="shrink-0 text-[10px] text-slate-500 hover:text-red-400"
                @click="handleRemoveTransferTeam(team.id)"
              >
                Remove
              </button>
            </li>
          </ul>
          <p v-else class="mt-2 text-center text-[11px] text-slate-500">
            No teams yet — add destinations for quick transfer.
          </p>
        </div>
      </Transition>

      <p v-if="callEndMessage" class="mt-1 truncate text-center text-xs text-amber-400/90">
        {{ callEndMessage }}
      </p>
      <p v-if="registerError" class="mt-1 truncate text-xs text-red-400">{{ registerError }}</p>
    </header>

    <main class="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2">
      <div
        v-if="isBootstrapping"
        class="flex flex-1 flex-col items-center justify-center gap-2 text-slate-400"
      >
        <span class="text-sm">Loading saved settings…</span>
      </div>

      <section
        v-else-if="showLoginForm"
        class="flex flex-1 flex-col justify-center py-2"
      >
        <form
          class="flex flex-col justify-center gap-5"
          @submit.prevent="handleLoginSubmit"
        >
          <div class="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
            <input
              v-model="extension"
              type="text"
              placeholder="Extension"
              autocomplete="username"
              :disabled="isLoggingIn"
              class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white placeholder:text-slate-500 outline-none focus:border-emerald-500 disabled:opacity-50"
            />
            <input
              v-model="password"
              type="password"
              placeholder="Password"
              autocomplete="current-password"
              :disabled="isLoggingIn"
              class="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-white placeholder:text-slate-500 outline-none focus:border-emerald-500 disabled:opacity-50"
            />
          </div>

          <button
            type="submit"
            class="w-full rounded-xl bg-emerald-600 py-3.5 text-base font-bold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isLoggingIn || !serverIp || !extension || !password"
          >
            {{ isLoggingIn ? 'Signing in…' : 'Sign in' }}
          </button>

          <div class="flex flex-col items-center gap-2">
          <button
            type="button"
            class="text-xs text-slate-500 transition hover:text-slate-300"
            :disabled="isLoggingIn"
            @click="showLoginAdvanced = !showLoginAdvanced"
          >
            {{ showLoginAdvanced ? 'Hide options' : 'More options' }}
          </button>

          <div
            v-if="showLoginAdvanced"
            class="w-full space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-sm"
          >
            <p
              v-if="isUcmHostFromEnv"
              class="rounded-lg border border-slate-700/80 bg-slate-950/80 px-3 py-2 text-slate-300"
            >
              <span class="block text-xs text-slate-500">UCM host</span>
              <span class="font-medium text-white">{{ serverIp }}</span>
              <span v-if="isUcmWsPortFromEnv" class="text-slate-500"> · WSS {{ wsPort }}</span>
            </p>
            <input
              v-else
              v-model="serverIp"
              type="text"
              placeholder="UCM host or IP"
              autocomplete="off"
              :disabled="isLoggingIn"
              class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white placeholder:text-slate-500 outline-none focus:border-emerald-500 disabled:opacity-50"
            />
            <input
              v-if="!isUcmWsPortFromEnv"
              v-model.number="wsPort"
              type="number"
              min="1"
              max="65535"
              placeholder="WSS port (8089)"
              :disabled="isLoggingIn"
              class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white placeholder:text-slate-500 outline-none focus:border-emerald-500 disabled:opacity-50"
            />
            <input
              v-model="localIpOverride"
              type="text"
              placeholder="Local IP override (optional)"
              autocomplete="off"
              :disabled="isLoggingIn"
              class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white placeholder:text-slate-500 outline-none focus:border-emerald-500 disabled:opacity-50"
            />
            <label class="flex cursor-pointer items-center gap-2 text-slate-400">
              <input
                v-model="preferLanIp"
                type="checkbox"
                class="rounded border-slate-600 text-emerald-600"
                :disabled="isLoggingIn"
              />
              Same LAN as UCM
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-slate-400">
              <input
                v-model="rememberConfig"
                type="checkbox"
                class="rounded border-slate-600 text-emerald-600"
                :disabled="isLoggingIn"
              />
              Remember settings
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-slate-400">
              <input
                v-model="autoLogin"
                type="checkbox"
                class="rounded border-slate-600 text-emerald-600"
                :disabled="isLoggingIn || !rememberConfig"
              />
              Sign in on startup
            </label>
            <button
              v-if="configStore.isAvailable()"
              type="button"
              class="w-full text-xs text-slate-500 hover:text-red-400"
              :disabled="isLoggingIn"
              @click="handleForgetConfig"
            >
              Clear saved settings
            </button>
          </div>
        </div>
        </form>
      </section>

      <section v-else class="flex min-h-0 flex-1 flex-col gap-2">
        <!-- Idle: call history -->
        <template v-if="showIdleCallHistory">
          <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-800/80 bg-slate-900/40">
            <div class="shrink-0 border-b border-slate-800/80 px-3 py-2.5">
              <div class="flex items-center justify-between gap-2">
                <p class="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Call history
                </p>
                <button
                  type="button"
                  class="text-[10px] text-slate-500 hover:text-slate-300"
                  @click="showCallHistory = false"
                >
                  Close
                </button>
              </div>
              <div class="mt-2 flex gap-1 rounded-lg bg-slate-950/80 p-0.5">
                <button
                  type="button"
                  class="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition"
                  :class="
                    callHistoryFilter === 'all'
                      ? 'bg-slate-700 text-white'
                      : 'text-slate-500 hover:text-slate-300'
                  "
                  @click="handleCallHistoryFilterChange('all')"
                >
                  All
                </button>
                <button
                  type="button"
                  class="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition"
                  :class="
                    callHistoryFilter === 'missed'
                      ? 'bg-slate-700 text-white'
                      : 'text-slate-500 hover:text-slate-300'
                  "
                  @click="handleCallHistoryFilterChange('missed')"
                >
                  Missed
                  <span
                    v-if="missedCallsCount > 0"
                    class="ml-1 text-red-400"
                  >({{ missedCallsCount }})</span>
                </button>
              </div>
            </div>

            <div v-if="isLoadingCallHistory" class="flex flex-1 items-center justify-center p-6">
              <span class="text-sm text-slate-500">Loading…</span>
            </div>

            <p
              v-else-if="filteredCallHistoryEmpty"
              class="flex flex-1 items-center justify-center p-6 text-center text-sm text-slate-500"
            >
              {{
                callHistoryFilter === 'missed'
                  ? 'No missed calls yet.'
                  : 'No calls recorded yet.'
              }}
            </p>

            <ul v-else class="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
              <li v-for="entry in callHistoryEntries" :key="entry.id">
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left transition hover:border-slate-700/60 hover:bg-slate-800/50 active:scale-[0.99]"
                  @click="handleHistoryDial(entry)"
                >
                  <span
                    class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    :class="
                      entry.outcome === 'missed'
                        ? 'bg-red-500/15 text-red-300'
                        : entry.direction === 'inbound'
                          ? 'bg-sky-500/15 text-sky-300'
                          : 'bg-emerald-500/15 text-emerald-300'
                    "
                    aria-hidden="true"
                  >
                    <svg
                      v-if="entry.outcome === 'missed'"
                      class="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M15.75 9.75V18m0 0h-7.5m7.5 0h7.5M3.75 9.75h16.5M5.25 6h13.5a1.5 1.5 0 011.5 1.5v1.5a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5V7.5A1.5 1.5 0 015.25 6z"
                      />
                    </svg>
                    <svg
                      v-else-if="entry.direction === 'inbound'"
                      class="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M15.75 9.75V18m0 0h-7.5m7.5 0h7.5M3.75 9.75h16.5M5.25 6h13.5a1.5 1.5 0 011.5 1.5v1.5a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5V7.5A1.5 1.5 0 015.25 6z"
                      />
                    </svg>
                    <svg
                      v-else
                      class="h-4 w-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M20.25 3.75v4.5m0-4.5h-4.5m4.5 0L15 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15"
                      />
                    </svg>
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center justify-between gap-2">
                      <p class="truncate font-mono text-sm font-semibold text-white">
                        {{ entry.remoteParty }}
                      </p>
                      <span class="shrink-0 text-[10px] text-slate-500">
                        {{ formatHistoryTimestamp(entry.startedAt) }}
                      </span>
                    </div>
                    <div class="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <span
                        class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        :class="outcomeBadgeClass(entry.outcome)"
                      >
                        {{ outcomeLabel(entry.outcome) }}
                      </span>
                      <span class="text-[10px] text-slate-500">
                        {{ directionSummary(entry.direction, entry.outcome) }}
                      </span>
                      <span
                        v-if="entry.outcome === 'answered'"
                        class="text-[10px] text-slate-500"
                      >
                        · {{ formatCallDuration(entry.durationSeconds) }}
                      </span>
                      <span
                        v-else-if="entry.statusLabel"
                        class="truncate text-[10px] text-slate-600"
                      >
                        · {{ entry.statusLabel }}
                      </span>
                    </div>
                  </div>
                </button>
              </li>
            </ul>

            <div
              v-if="callHistoryEntries.length > 0"
              class="shrink-0 border-t border-slate-800/80 p-2"
            >
              <button
                type="button"
                class="w-full rounded-lg py-2 text-xs text-slate-500 transition hover:bg-slate-800/60 hover:text-red-300"
                @click="handleClearCallHistory"
              >
                Clear history
              </button>
            </div>
          </div>
        </template>

        <!-- Idle: number entry + dial pad + call -->
        <template v-else-if="showIdleDialer">
          <div class="shrink-0 rounded-xl border border-slate-800/80 bg-slate-900/40 px-3 py-3">
            <label class="sr-only" for="target-extension">Number to dial</label>
            <input
              id="target-extension"
              v-model="targetExtension"
              type="tel"
              inputmode="tel"
              placeholder="Enter Number..."
              class="w-full bg-transparent text-center text-2xl font-light tracking-wider text-white outline-none placeholder:text-lg placeholder:text-slate-500/80"
            />
            <button
              v-if="targetExtension"
              type="button"
              class="mt-1 w-full text-[10px] text-slate-500 hover:text-slate-300"
              @click="backspaceDigit"
            >
              Backspace
            </button>
          </div>

          <div class="grid min-h-0 flex-1 grid-cols-3 gap-1.5 content-start">
            <button
              v-for="key in DIAL_PAD"
              :key="key"
              type="button"
              class="flex h-11 items-center justify-center rounded-xl border border-slate-700/40 bg-slate-800/60 text-lg font-semibold text-slate-100 transition-all duration-150 hover:bg-slate-700/80 active:scale-95"
              @click="appendDigit(key)"
            >
              {{ key }}
            </button>
          </div>

          <button
            type="button"
            class="shrink-0 w-full rounded-xl bg-emerald-600 py-3 text-sm font-medium text-white shadow-[0_4px_20px_rgba(16,185,129,0.2)] transition-all hover:bg-emerald-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!canCall"
            @click="handleCall"
          >
            Call
          </button>
        </template>

        <!-- Active session: call dashboard -->
        <template v-else-if="hasActiveSession">
          <div
            class="flex min-h-0 flex-1 flex-col space-y-6 overflow-y-auto p-4"
            :class="isStartingConsultation ? 'pointer-events-none opacity-60' : ''"
          >
            <div
              class="rounded-2xl border border-slate-800/80 bg-slate-900/50 px-4 py-5 text-center"
            >
              <p
                class="text-xl font-bold tracking-tight"
                :class="
                  isInTransferConsultation
                    ? 'text-violet-300'
                    : connectionStatus === 'connected'
                      ? isOnHold
                        ? 'text-sky-300'
                        : 'text-emerald-300'
                      : 'text-amber-300'
                "
              >
                {{ activeCallStatusLine }}
              </p>
              <p
                v-if="connectionStatus === 'connected' && (callerId || targetExtension)"
                class="mt-1 truncate text-sm font-medium text-slate-400"
              >
                {{ callerId || targetExtension }}
              </p>
            </div>

            <div
              v-if="transferStatusMessage"
              class="flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium"
              :class="
                isInTransferConsultation
                  ? 'border-violet-500/30 bg-violet-950/40 text-violet-200'
                  : 'border-sky-500/30 bg-sky-950/40 text-sky-200'
              "
              role="status"
              aria-live="polite"
            >
              <span
                v-if="isStartingConsultation || sipSessionState === SessionState.Establishing"
                class="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-60"
                aria-hidden="true"
              />
              {{ transferStatusMessage }}
            </div>

            <div
              v-if="isInTransferConsultation"
              class="grid w-full grid-cols-1 gap-2 sm:grid-cols-2"
            >
              <button
                type="button"
                class="w-full rounded-xl bg-emerald-600 px-4 py-3.5 text-sm font-semibold text-white shadow-[0_4px_24px_rgba(16,185,129,0.35)] transition-all hover:bg-emerald-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
                :disabled="!canCompleteAttendedTransfer || isStartingConsultation"
                @click="handleCompleteAttendedTransfer"
              >
                Complete Transfer (Merge)
              </button>
              <button
                type="button"
                class="w-full rounded-xl border border-slate-600 bg-slate-800/80 px-4 py-3.5 text-sm font-semibold text-slate-200 transition-all hover:border-slate-500 hover:bg-slate-700/80 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
                :disabled="isStartingConsultation"
                @click="handleCancelAttendedTransfer"
              >
                Cancel Transfer
              </button>
            </div>

            <div class="grid w-full grid-cols-3 gap-3">
              <button
                type="button"
                class="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-2xl border text-xs font-semibold transition-all duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                :class="
                  isMuted
                    ? 'border-amber-500/50 bg-amber-950/60 text-amber-200 shadow-[inset_0_0_0_1px_rgba(251,191,36,0.2)]'
                    : 'border-slate-700/60 bg-slate-800/70 text-slate-200 hover:bg-slate-700/80'
                "
                :disabled="callControlsDisabled || !canUseSessionMediaControls"
                :aria-pressed="isMuted"
                @click="handleToggleMute"
              >
                <svg
                  class="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="1.75"
                  aria-hidden="true"
                >
                  <path
                    v-if="isMuted"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-10.5-6h.008v.008H6.75V9.75zm0 0h.008v.008H6.75V9.75zm0 0v4.5m0-4.5h.008v.008H6.75V9.75zM12 18.75a6.75 6.75 0 006.75-6.75v-3.375a6.75 6.75 0 00-13.5 0V12a6.75 6.75 0 006.75 6.75z"
                  />
                  <path
                    v-else
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 18.75a6.75 6.75 0 006.75-6.75v-3.375a6.75 6.75 0 00-13.5 0v3.375a6.75 6.75 0 006.75 6.75zM12 9.75V6.75m0 0V4.5m0 2.25h.008v.008H12V9.75z"
                  />
                </svg>
                {{ isMuted ? 'Unmute' : 'Mute' }}
              </button>

              <button
                type="button"
                class="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-2xl border text-xs font-semibold transition-all duration-150 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                :class="
                  isOnHold
                    ? 'border-sky-500/50 bg-sky-950/60 text-sky-200 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.2)]'
                    : 'border-slate-700/60 bg-slate-800/70 text-slate-200 hover:bg-slate-700/80'
                "
                :disabled="callControlsDisabled || !canUseSessionMediaControls"
                :aria-pressed="isOnHold"
                @click="handleToggleHold"
              >
                <svg
                  class="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="1.75"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M15.75 5.25v13.5m-7.5-13.5v13.5"
                  />
                </svg>
                {{ isHoldPending ? '…' : isOnHold ? 'Resume' : 'Hold' }}
              </button>

              <button
                type="button"
                class="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-2xl bg-red-600 text-xs font-medium text-white shadow-[0_4px_16px_rgba(239,68,68,0.35)] transition-all duration-150 hover:bg-red-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="callControlsDisabled"
                @click="handleHangUp"
              >
                <svg
                  class="h-6 w-6"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="1.75"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M15.75 3.75L18 6m0 0l2.25 2.25M18 6l2.25-2.25M18 6l-2.25 2.25M5.25 3.75L3 6m0 0l2.25 2.25M3 6l2.25-2.25M3 6l2.25 2.25m12 7.5V18a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 18v-4.5"
                  />
                </svg>
                Hang Up
              </button>
            </div>

            <div v-if="!isInTransferConsultation" class="space-y-3">
              <p class="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                Quick transfer
              </p>
              <p class="text-[10px] text-slate-600">
                Tap a team to consult, then merge when ready.
              </p>

              <p
                v-if="transferTeams.length === 0"
                class="rounded-xl border border-dashed border-slate-700/60 px-4 py-5 text-center text-xs text-slate-500"
              >
                No transfer teams configured
              </p>

              <div v-else class="grid grid-cols-2 gap-2">
                <button
                  v-for="team in transferTeams"
                  :key="team.id"
                  type="button"
                  class="rounded-xl border border-slate-700/50 bg-slate-800/40 px-3 py-2.5 text-left transition-all duration-150 hover:border-blue-500/60 hover:bg-blue-600/15 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="callControlsDisabled || !canUseSessionMediaControls"
                  @click="handleQuickTransfer(team)"
                >
                  <span class="block truncate text-sm font-semibold text-slate-100">
                    {{ team.name }}
                  </span>
                  <span class="mt-0.5 font-mono text-xs text-slate-500">{{ team.extension }}</span>
                </button>
              </div>
            </div>
          </div>
        </template>
      </section>
    </main>

    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-300 ease-out"
        enter-from-class="opacity-0"
        enter-to-class="opacity-100"
        leave-active-class="transition duration-200 ease-in"
        leave-from-class="opacity-100"
        leave-to-class="opacity-0"
      >
        <div
          v-if="showIncomingOverlay"
          class="fixed inset-0 z-[10000] flex items-end justify-center bg-slate-950/85 p-4 pb-8 backdrop-blur-md sm:items-center"
          role="alertdialog"
          aria-labelledby="incoming-call-title"
          aria-describedby="incoming-call-caller"
        >
          <Transition
            appear
            enter-active-class="transition duration-350 ease-out"
            enter-from-class="opacity-0 translate-y-full sm:translate-y-8 sm:scale-95"
            enter-to-class="opacity-100 translate-y-0 sm:scale-100"
            leave-active-class="transition duration-250 ease-in"
            leave-from-class="opacity-100 translate-y-0"
            leave-to-class="opacity-0 translate-y-full sm:translate-y-8"
          >
            <div
              v-if="showIncomingOverlay"
              class="w-full max-w-sm rounded-3xl border border-sky-500/40 bg-slate-900 p-8 shadow-2xl shadow-sky-500/25"
            >
              <div class="flex flex-col items-center text-center">
                <div
                  class="mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-sky-500/15 ring-4 ring-sky-400/50 ring-offset-4 ring-offset-slate-900 animate-pulse"
                >
                  <svg
                    class="h-12 w-12 text-sky-400"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="1.5"
                    aria-hidden="true"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.72 1.08a12.04 12.04 0 01-5.69-5.69l1.08-.72c.363-.271.527-.734.417-1.173L6.963 3.85A1.125 1.125 0 005.872 3H4.5A2.25 2.25 0 002.25 5.25v1.5z"
                    />
                  </svg>
                </div>

                <p
                  id="incoming-call-title"
                  class="text-xs font-semibold uppercase tracking-[0.2em] text-sky-400"
                >
                  Incoming call
                </p>
                <p id="incoming-call-caller" class="mt-3 text-4xl font-bold tracking-tight text-white">
                  {{ callerId }}
                </p>
                <p class="mt-2 text-sm text-slate-400 animate-pulse">Ringing…</p>
              </div>

              <div class="mt-10 grid grid-cols-2 gap-4">
                <button
                  type="button"
                  class="flex items-center justify-center gap-2 rounded-2xl bg-red-600 py-4 text-base font-semibold text-white shadow-lg shadow-red-900/40 transition hover:bg-red-500 active:scale-95"
                  @click="handleReject"
                >
                  Decline
                </button>
                <button
                  type="button"
                  class="flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 py-4 text-base font-semibold text-white shadow-lg shadow-emerald-900/40 transition hover:bg-emerald-500 active:scale-95 disabled:opacity-50"
                  :disabled="isAnswering"
                  @click="handleAccept"
                >
                  <svg
                    v-if="!isAnswering"
                    class="h-5 w-5 shrink-0"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.72 1.08a12.04 12.04 0 01-5.69-5.69l1.08-.72c.363-.271.527-.734.417-1.173L6.963 3.85A1.125 1.125 0 005.872 3H4.5A2.25 2.25 0 002.25 5.25v1.5z"
                    />
                  </svg>
                  {{ isAnswering ? 'Answering…' : 'Accept Call' }}
                </button>
              </div>
            </div>
          </Transition>
        </div>
      </Transition>
    </Teleport>

    <audio ref="remoteAudio" autoplay playsinline class="remote-audio" />
  </div>
</template>

<style scoped>
div:first-child {
  position: relative;
}

.remote-audio {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
}
</style>
