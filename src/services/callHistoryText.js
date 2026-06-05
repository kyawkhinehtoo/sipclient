import { formatCallEndStatus } from './callStatusText.js';

/**
 * @typedef {'inbound' | 'outbound'} CallDirection
 * @typedef {'answered' | 'missed' | 'outbound_no_answer' | 'cancelled' | 'failed'} CallOutcome
 */

/**
 * @param {{ direction: CallDirection, wasEstablished: boolean }} meta
 * @param {number | undefined} statusCode
 * @param {string | undefined} reasonPhrase
 * @returns {CallOutcome}
 */
export function resolveCallOutcome(meta, statusCode, reasonPhrase) {
  if (meta.wasEstablished) {
    return 'answered';
  }

  if (meta.direction === 'inbound') {
    return 'missed';
  }

  if (statusCode === 487 || reasonPhrase?.toLowerCase().includes('cancel')) {
    return 'cancelled';
  }

  if (statusCode === 486 || statusCode === 600 || statusCode === 603) {
    return 'outbound_no_answer';
  }

  if (statusCode === 408 || statusCode === 480) {
    return 'outbound_no_answer';
  }

  return 'failed';
}

/**
 * @param {CallOutcome} outcome
 * @returns {string}
 */
export function outcomeLabel(outcome) {
  switch (outcome) {
    case 'answered':
      return 'Answered';
    case 'missed':
      return 'Missed';
    case 'outbound_no_answer':
      return 'No answer';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Failed';
  }
}

/**
 * @param {CallOutcome} outcome
 * @returns {string} Tailwind color classes for badge text
 */
export function outcomeBadgeClass(outcome) {
  switch (outcome) {
    case 'answered':
      return 'bg-emerald-500/15 text-emerald-300';
    case 'missed':
      return 'bg-red-500/15 text-red-300';
    case 'outbound_no_answer':
      return 'bg-amber-500/15 text-amber-300';
    case 'cancelled':
      return 'bg-slate-500/15 text-slate-400';
    default:
      return 'bg-orange-500/15 text-orange-300';
  }
}

/**
 * @param {CallDirection} direction
 * @param {CallOutcome} outcome
 * @returns {string}
 */
export function directionSummary(direction, outcome) {
  if (outcome === 'missed') {
    return 'Missed call';
  }
  if (direction === 'inbound') {
    return 'Incoming';
  }
  return 'Outgoing';
}

/**
 * @param {number} seconds
 * @returns {string}
 */
export function formatCallDuration(seconds) {
  if (!seconds || seconds < 1) {
    return '—';
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) {
    return `${remainder}s`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

/**
 * @param {string} iso
 * @returns {string}
 */
export function formatHistoryTimestamp(iso) {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }

  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  if (isToday) {
    return time;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) {
    return `Yesterday ${time}`;
  }

  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * @param {number | undefined} statusCode
 * @param {string | undefined} reasonPhrase
 * @returns {string}
 */
export function historyStatusLabel(statusCode, reasonPhrase) {
  return formatCallEndStatus(statusCode, reasonPhrase) || '';
}
