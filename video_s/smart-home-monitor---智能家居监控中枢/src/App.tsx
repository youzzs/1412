/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ShieldCheck,
  Activity,
  RefreshCw,
  Globe,
  Settings,
  Flame,
  Cloud,
  PersonStanding,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  Target,
  Scan,
  Sun,
  Moon,
  Camera,
  Terminal,
} from 'lucide-react';
import { translations as t } from './constants';
import { cn } from './lib/utils';
import {
  APP_CONFIG,
  CAMERA_STORAGE_HOST,
  LOG_PANEL_ENABLED_KEY,
  type AlertOut,
  apiUrl,
  cameraScheme,
  fingerprintAlert,
  getAlertsUrl,
  getCaptureUrl,
  getStreamUrl,
  mapEventForDisplay,
  postJson,
} from './config';

const THREE_ALERT_TYPES = new Set(
  Object.keys(APP_CONFIG.events).map((k) => k.toLowerCase()),
);

type StatusHeroKind = 'safe' | 'fire' | 'smoke' | 'fall';

function resolveStatusHeroKind(
  activeMode: 'monitor' | 'search' | 'track',
  alertState: 'idle' | 'alerting',
  eventType: string | undefined,
): StatusHeroKind {
  if (activeMode !== 'monitor') return 'safe';
  if (alertState !== 'alerting') return 'safe';
  const et = String(eventType ?? '').toLowerCase();
  if (et === 'fire_alarm') return 'fire';
  if (et === 'smoke_alarm') return 'smoke';
  if (et === 'fall_detected') return 'fall';
  return 'safe';
}

interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

function toClockText(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function readStoredCamHost(): string {
  try {
    return localStorage.getItem(CAMERA_STORAGE_HOST) || APP_CONFIG.camera.defaultHost;
  } catch {
    return APP_CONFIG.camera.defaultHost;
  }
}

function readLogsPanelEnabled(): boolean {
  try {
    const v = localStorage.getItem(LOG_PANEL_ENABLED_KEY);
    if (v === null) return true;
    return v === 'true';
  } catch {
    return true;
  }
}

function MonitorApp() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [camHost, setCamHost] = useState(readStoredCamHost);
  const [camStatus, setCamStatus] = useState<'INITIALIZING' | 'ACTIVE' | 'ERROR'>('INITIALIZING');
  const [activeMode, setActiveMode] = useState<'monitor' | 'search' | 'track'>('monitor');
  const [searchQuery, setSearchQuery] = useState('');
  const [alertState, setAlertState] = useState<'idle' | 'alerting'>('idle');
  const [latestAlert, setLatestAlert] = useState<AlertOut | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [apiConnected, setApiConnected] = useState(false);
  const [temperatureC, setTemperatureC] = useState<number | null>(null);
  /** 无遥测或非数值时默认 24°C */
  const displayTemperature =
    temperatureC != null && !Number.isNaN(temperatureC) ? temperatureC : 24;
  const [streamBust, setStreamBust] = useState(() => Date.now());
  const [logsPanelEnabled, setLogsPanelEnabled] = useState(readLogsPanelEnabled);

  const logContainerRef = useRef<HTMLDivElement>(null);
  const lastFingerprintRef = useRef('');

  /** 始终使用 HTTPS 默认端口（443），与 `http/config.js` 中 port: null 一致 */
  const camPortNum = null;
  const streamSrc = `${getStreamUrl(camHost, camPortNum)}?t=${streamBust}`;

  const addLog = useCallback((message: string, level: 'info' | 'warn' | 'error' = 'info') => {
    setLogs((prev) => {
      const entry: LogEntry = {
        id: Math.random().toString(36).substring(7),
        timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        level,
        message,
      };
      return [...prev.slice(-49), entry];
    });
  }, []);

  useEffect(() => {
    document.body.className = theme;
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(LOG_PANEL_ENABLED_KEY, String(logsPanelEnabled));
    } catch {
      /* ignore */
    }
  }, [logsPanelEnabled]);

  useEffect(() => {
    addLog('系统初始化已完成', 'info');
    addLog(`API · ${getAlertsUrl(APP_CONFIG.api.latestAlertsLimit)}`, 'info');
  }, [addLog]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const url = getAlertsUrl(APP_CONFIG.api.latestAlertsLimit);
        const teleUrl = apiUrl(APP_CONFIG.api.telemetryPath);
        const [res, teleRes] = await Promise.all([
          fetch(url, { cache: 'no-store' }),
          fetch(teleUrl, { cache: 'no-store' }),
        ]);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arr: unknown = await res.json();
        if (cancelled) return;
        setApiConnected(true);

        if (teleRes.ok) {
          try {
            const tj = (await teleRes.json()) as {
              temperature_celsius?: number | null;
            };
            const tc = tj?.temperature_celsius;
            if (typeof tc === 'number' && !Number.isNaN(tc)) {
              setTemperatureC(tc);
            } else if (tc === null || tc === undefined) {
              setTemperatureC(null);
            }
          } catch {
            /* ignore malformed telemetry */
          }
        }

        const latest =
          Array.isArray(arr) && arr.length > 0 ? (arr[0] as AlertOut) : null;
        if (!latest) return;
        const et = String(latest.event_type ?? '').toLowerCase();
        if (!THREE_ALERT_TYPES.has(et)) return;
        const fp = fingerprintAlert(latest);
        if (fp === lastFingerprintRef.current) return;
        lastFingerprintRef.current = fp;
        setLatestAlert(latest);
        setAlertState('alerting');
        const { title } = mapEventForDisplay(latest.event_type);
        addLog(`ALERT · ${title}`, 'error');
      } catch (err) {
        if (cancelled) return;
        setApiConnected(false);
        addLog(
          `! API ${err instanceof Error ? err.message : String(err)}`,
          'warn',
        );
      }
    };
    tick();
    const id = setInterval(tick, APP_CONFIG.polling.intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [addLog]);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs]);

  const persistCameraAndBust = () => {
    try {
      localStorage.setItem(CAMERA_STORAGE_HOST, camHost.trim());
    } catch {
      /* ignore */
    }
    setStreamBust(Date.now());
  };

  const handleConnect = () => {
    setCamStatus('INITIALIZING');
    setIsSettingsOpen(false);
    addLog(`VIDEO · 正在连接 ${getStreamUrl(camHost, camPortNum)}`, 'info');
    persistCameraAndBust();
  };

  const handleReloadStream = () => {
    setCamStatus('INITIALIZING');
    addLog('VIDEO · stream reload requested', 'info');
    persistCameraAndBust();
  };

  const handleCapture = () => {
    const u = `${getCaptureUrl(camHost, camPortNum)}?t=${Date.now()}`;
    setSnapshotUrl(u);
    addLog('> CAPTURE single-frame pull', 'info');
  };

  const handleResetAlerts = () => {
    // 保留当前条目的指纹：服务端列表未变时轮询仍会返回同一告警；清空 ref 会导致下一轮误判为「新告警」再次进入 alerting
    if (latestAlert) {
      lastFingerprintRef.current = fingerprintAlert(latestAlert);
    }
    setAlertState('idle');
    setLatestAlert(null);
    addLog('> 告警已复位 · STANDBY', 'info');
  };

  const moveCamera = async (direction: string) => {
    const dirNum: Record<string, number> = {
      up: 1,
      down: 2,
      left: 3,
      right: 4,
    };
    const dirLabel: Record<string, string> = {
      up: '向上',
      down: '向下',
      left: '向左',
      right: '向右',
    };
    const n = dirNum[direction];
    if (n == null) return;
    try {
      await postJson(APP_CONFIG.api.ptzPath, {
        message_type: '移动',
        direction: n,
      });
      addLog(
        `云台 · 移动 · ${dirLabel[direction] ?? direction}（方向 ${n}）已发送`,
        'info',
      );
    } catch (e) {
      addLog(`! 云台 ${e instanceof Error ? e.message : String(e)}`, 'warn');
    }
  };

  const alertCopy =
    latestAlert != null ? mapEventForDisplay(latestAlert.event_type) : null;

  const statusHeroKind = useMemo(
    () => resolveStatusHeroKind(activeMode, alertState, latestAlert?.event_type),
    [activeMode, alertState, latestAlert?.event_type],
  );

  const endpointLabel = `${camHost} · ${cameraScheme().toUpperCase()}`;

  const ptzPadButtonClassName = cn(
    'p-3 rounded-xl text-brand-primary transition-all active:scale-90 shadow-sm',
    'hover:bg-brand-primary hover:text-white',
    theme === 'light'
      ? 'bg-[#26292f] border border-white/5'
      : 'bg-white border border-slate-100',
  );

  return (
    <div className="flex min-h-dvh w-full flex-col px-5 py-4 md:h-full md:min-h-0 md:max-h-full md:overflow-hidden lg:px-8 selection:bg-brand-primary selection:text-white">
      <header className="flex shrink-0 items-center justify-between pb-3">
        <div className="space-y-1">
          <h1
            className={cn(
              'text-3xl font-black tracking-tight',
              theme === 'dark' ? 'text-white' : 'text-slate-950',
            )}
          >
            {t.title}
          </h1>
          <p
            className={cn(
              'text-[11px] font-bold uppercase tracking-[0.4em]',
              theme === 'dark' ? 'text-slate-400' : 'text-slate-600',
            )}
          >
            {t.subtitle}
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex bg-slate-100 dark:bg-[#2d3139] p-1 rounded-2xl border border-slate-200 dark:border-[#3d424b] shadow-inner">
            <button
              type="button"
              onClick={() => setTheme('light')}
              className={cn(
                'p-2.5 rounded-xl transition-all cursor-pointer',
                theme === 'light'
                  ? 'bg-white text-brand-primary shadow-md'
                  : 'text-slate-500 hover:text-brand-primary',
              )}
            >
              <Sun className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setTheme('dark')}
              className={cn(
                'p-2.5 rounded-xl transition-all cursor-pointer',
                theme === 'dark'
                  ? 'bg-[#373c44] text-brand-primary shadow-md'
                  : 'text-slate-500 hover:text-brand-primary',
              )}
            >
              <Moon className="h-4 w-4" />
            </button>
          </div>

          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="p-3 rounded-2xl bg-white dark:bg-[#2d3139] border border-slate-200 dark:border-[#3d424b] text-slate-800 dark:text-slate-200 hover:shadow-lg transition-all active:scale-95 shadow-sm group"
          >
            <Settings className="h-5 w-5 group-hover:rotate-45 transition-transform" />
          </button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden md:grid-cols-12 md:gap-5">
        <div className="flex h-full min-h-0 flex-col gap-4 overflow-hidden md:col-span-8 md:gap-5">
          <section className="bento-card relative min-h-[200px] flex-1 basis-0 overflow-hidden bg-[#0a0f1d] shadow-2xl md:min-h-0">
            <div className="absolute top-6 left-6 z-10 flex flex-col gap-2 pointer-events-none">
              <div className="flex items-center gap-4 bg-black/40 backdrop-blur-3xl px-4 py-2 rounded-2xl border border-white/10">
                <div
                  className={cn(
                    'w-2 h-2 rounded-full',
                    camStatus === 'ACTIVE'
                      ? 'bg-emerald-400 animate-pulse'
                      : camStatus === 'ERROR'
                        ? 'bg-red-500'
                        : 'bg-slate-500',
                  )}
                />
                <span className="text-white text-[10px] font-black tracking-widest uppercase">
                  {t.zone} •{' '}
                  {camStatus === 'ACTIVE'
                    ? t.status_active
                    : camStatus === 'ERROR'
                      ? t.status_error
                      : t.status_initializing}
                </span>
              </div>
              <div className="flex items-center gap-4 bg-black/40 backdrop-blur-3xl px-4 py-2 rounded-2xl border border-white/10">
                <div
                  className={cn(
                    'w-2 h-2 rounded-full',
                    apiConnected ? 'bg-emerald-400' : 'bg-amber-500',
                  )}
                />
                <span className="text-white text-[10px] font-black tracking-widest uppercase">
                  {apiConnected ? APP_CONFIG.ui.apiOk : '告警接口未连接'}
                </span>
              </div>
            </div>

            <div className="absolute top-6 right-6 z-10 flex gap-2 pointer-events-auto">
              <button
                type="button"
                onClick={handleReloadStream}
                className="p-2.5 rounded-xl bg-black/40 backdrop-blur-3xl border border-white/10 text-white hover:bg-white/10 transition-colors"
                title="重载视频流"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={handleCapture}
                className="p-2.5 rounded-xl bg-black/40 backdrop-blur-3xl border border-white/10 text-white hover:bg-white/10 transition-colors"
                title={t.capture_frame}
              >
                <Camera className="h-4 w-4" />
              </button>
            </div>

            <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
              <div className="absolute inset-0 radar-grid opacity-10" />
              <img
                key={streamBust}
                src={streamSrc}
                alt="MJPEG stream"
                className="absolute inset-0 w-full h-full object-contain bg-black"
                onLoad={() => {
                  setCamStatus('ACTIVE');
                  addLog('VIDEO · frame channel locked · MUX OK', 'info');
                }}
                onError={() => {
                  setCamStatus('ERROR');
                  addLog(
                    `! VIDEO · ${APP_CONFIG.ui.streamFail}`,
                    'error',
                  );
                }}
              />
              {camStatus === 'INITIALIZING' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-white/30 bg-black/50 pointer-events-none">
                  <RefreshCw className="h-12 w-12 animate-spin" />
                </div>
              )}
            </div>

            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[5] pointer-events-none text-white/20 text-[10px] font-black tracking-[0.35em] uppercase">
              LIVE · MJPEG · {cameraScheme().toUpperCase()}
            </div>

            <div className="absolute inset-x-0 bottom-0 p-8 flex flex-col md:flex-row justify-between items-end gap-6 bg-gradient-to-t from-black/60 to-transparent pointer-events-none">
              <div className="text-white space-y-1">
                <p className="text-3xl md:text-4xl font-black tracking-tighter opacity-95">
                  {t.realtime_monitoring}
                </p>
                <div className="flex items-center gap-3">
                  <Globe className="h-3 w-3 text-brand-primary" />
                  <p className="text-xs font-bold text-white/60 font-mono tracking-wider">
                    {endpointLabel}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-5xl md:text-6xl font-thin text-brand-primary/90 font-mono tracking-tighter">
                  {new Date()
                    .toLocaleTimeString('zh-CN', { hour12: false })
                    .split(':')
                    .slice(0, 2)
                    .join(':')}
                  <span className="text-xl ml-1 opacity-50">
                    {
                      new Date()
                        .toLocaleTimeString('zh-CN', { hour12: false })
                        .split(':')[2]
                    }
                  </span>
                </p>
                <p className="text-[9px] font-black text-white/50 tracking-[0.2em] uppercase mt-1">
                  {new Date().toLocaleDateString('zh-CN', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  })}
                </p>
              </div>
            </div>
          </section>

          <div className="grid shrink-0 grid-cols-1 gap-4 sm:grid-cols-2 sm:h-[10.25rem] sm:min-h-0">
            <div className="bento-card relative flex min-h-[7rem] flex-col items-stretch justify-between overflow-hidden p-4 sm:h-full sm:min-h-0 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <span
                  className={cn(
                    'text-left text-[11px] font-bold uppercase tracking-[0.18em] sm:text-xs',
                    theme === 'dark' ? 'text-slate-400' : 'text-slate-600',
                  )}
                >
                  环境温度
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider',
                    theme === 'dark'
                      ? 'bg-white/5 text-slate-500'
                      : 'bg-slate-100 text-slate-500',
                  )}
                >
                  Live
                </span>
              </div>
              <div className="flex flex-1 flex-col items-stretch justify-center py-1 sm:py-0">
                <div
                  className={cn(
                    'temp-metric',
                    'text-[clamp(2.65rem,6.5vw,3.65rem)]',
                  )}
                >
                  <span
                    className={cn(
                      'temp-metric__value',
                      theme === 'dark' ? 'text-white' : 'text-slate-900',
                    )}
                  >
                    {displayTemperature.toFixed(1)}
                  </span>
                  <span
                    className={cn(
                      'temp-metric__unit',
                      theme === 'dark' ? 'text-slate-300' : 'text-slate-600',
                    )}
                  >
                    °C
                  </span>
                </div>
              </div>
            </div>

            <div className="bento-card flex min-h-[7rem] items-center justify-center p-3 sm:h-full sm:min-h-0">
              <div className="grid grid-cols-3 gap-2">
                <div />
                <button
                  type="button"
                  onClick={() => moveCamera('up')}
                  className={ptzPadButtonClassName}
                >
                  <ChevronUp className="h-5 w-5 text-current" />
                </button>
                <div />
                <button
                  type="button"
                  onClick={() => moveCamera('left')}
                  className={ptzPadButtonClassName}
                >
                  <ChevronLeft className="h-5 w-5 text-current" />
                </button>
                <div className="flex items-center justify-center">
                  <div className="w-2.5 h-2.5 rounded-full bg-brand-primary/40 animate-pulse" />
                </div>
                <button
                  type="button"
                  onClick={() => moveCamera('right')}
                  className={ptzPadButtonClassName}
                >
                  <ChevronRight className="h-5 w-5 text-current" />
                </button>
                <div />
                <button
                  type="button"
                  onClick={() => moveCamera('down')}
                  className={ptzPadButtonClassName}
                >
                  <ChevronDown className="h-5 w-5 text-current" />
                </button>
                <div />
              </div>
            </div>
          </div>
        </div>

        <div className="flex h-full max-md:min-h-[22rem] min-h-0 flex-col gap-2 overflow-hidden md:col-span-4 md:gap-3">
          <section
            className={cn(
              'bento-card flex flex-1 min-h-0 basis-0 flex-col gap-0 overflow-hidden border-none p-4 shadow-xl transition-all duration-500 md:p-5',
              'bg-white dark:bg-[#26292f]',
            )}
          >
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex shrink-0 items-start justify-between gap-2">
                <h3
                  className={cn(
                    'text-[10px] font-black uppercase tracking-[0.22em] md:text-[11px]',
                    theme === 'dark' ? 'text-slate-400' : 'text-slate-600',
                  )}
                >
                  {alertState === 'alerting' ? 'SECURITY ALERT' : 'SYSTEM STATUS'}
                </h3>
                <div
                  className={cn(
                    'flex max-w-[58%] flex-col items-end gap-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400',
                  )}
                >
                  <span
                    className={cn(
                      apiConnected
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400',
                    )}
                  >
                    {apiConnected ? 'API 已连接' : 'API 未连接'}
                  </span>
                </div>
              </div>

              <div
                className={cn(
                  'relative flex min-h-[11rem] flex-1 flex-col items-center justify-center overflow-hidden rounded-[1.75rem] px-2 py-5 sm:min-h-[13.5rem]',
                  theme === 'dark'
                    ? 'bg-black/25'
                    : 'bg-gradient-to-b from-brand-primary/[0.08] to-slate-50/50',
                )}
              >
                <AnimatePresence mode="wait">
                  <motion.div
                    key={`${statusHeroKind}-${activeMode}`}
                    role="status"
                    aria-live="polite"
                    initial={{ opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.96 }}
                    transition={{ duration: 0.18, ease: 'easeOut' }}
                    className="flex flex-col items-center justify-center text-center"
                  >
                    {statusHeroKind === 'safe' && (
                      <ShieldCheck
                        className={cn(
                          'h-[min(44vw,12rem)] w-[min(44vw,12rem)] sm:h-[13.5rem] sm:w-[13.5rem] shrink-0 text-brand-primary',
                        )}
                        strokeWidth={1.05}
                        aria-hidden
                      />
                    )}
                    {statusHeroKind === 'fire' && (
                      <Flame
                        className={cn(
                          'h-[min(44vw,12rem)] w-[min(44vw,12rem)] shrink-0 drop-shadow-md sm:h-[13.5rem] sm:w-[13.5rem]',
                          theme === 'dark'
                            ? 'text-red-500'
                            : 'text-orange-600',
                        )}
                        strokeWidth={1.05}
                        aria-hidden
                      />
                    )}
                    {statusHeroKind === 'smoke' && (
                      <Cloud
                        className={cn(
                          'h-[min(44vw,12rem)] w-[min(44vw,12rem)] shrink-0 drop-shadow-md sm:h-[13.5rem] sm:w-[13.5rem]',
                          theme === 'dark' ? 'text-slate-300' : 'text-slate-600',
                        )}
                        strokeWidth={1.05}
                        aria-hidden
                      />
                    )}
                    {statusHeroKind === 'fall' && (
                      <PersonStanding
                        className={cn(
                          'h-[min(44vw,12rem)] w-[min(44vw,12rem)] shrink-0 drop-shadow-md sm:h-[13.5rem] sm:w-[13.5rem]',
                          theme === 'dark' ? 'text-slate-300' : 'text-slate-700',
                        )}
                        strokeWidth={1.05}
                        aria-hidden
                      />
                    )}

                    {statusHeroKind === 'safe' && activeMode !== 'monitor' && (
                      <span className="sr-only">安全</span>
                    )}

                    {(statusHeroKind !== 'safe' || activeMode === 'monitor') && (
                    <p
                      className={cn(
                        'mt-4 max-w-[18rem] px-2 text-lg font-black tracking-tight sm:text-xl',
                        theme === 'dark' ? 'text-white' : 'text-slate-900',
                      )}
                    >
                      {statusHeroKind === 'safe' && activeMode === 'monitor' && '安全'}
                      {statusHeroKind === 'fire' && '火灾警报'}
                      {statusHeroKind === 'smoke' && '烟雾警报'}
                      {statusHeroKind === 'fall' && '人员跌倒'}
                    </p>
                    )}

                    {statusHeroKind === 'safe' &&
                      activeMode === 'monitor' &&
                      alertState !== 'alerting' && (
                        <p
                          className={cn(
                            'mt-1 text-xs font-semibold',
                            theme === 'dark' ? 'text-slate-300' : 'text-slate-600',
                          )}
                        >
                          系统运行正常
                        </p>
                      )}

                    {alertState === 'alerting' &&
                      alertCopy &&
                      statusHeroKind !== 'safe' && (
                        <p
                          className={cn(
                            'mt-2 max-w-[19rem] px-3 text-sm font-semibold leading-snug',
                            theme === 'dark' ? 'text-slate-300' : 'text-slate-600',
                          )}
                        >
                          {alertCopy.message}
                        </p>
                      )}

                    {alertState === 'alerting' &&
                      latestAlert &&
                      statusHeroKind !== 'safe' && (
                        <p
                          className={cn(
                            'mt-3 font-mono text-sm font-bold tabular-nums tracking-wide',
                            theme === 'dark' ? 'text-slate-300' : 'text-slate-600',
                          )}
                        >
                          {toClockText(latestAlert.received_at)}
                        </p>
                      )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            <div
              className={cn(
                'mt-auto flex shrink-0 flex-col gap-2.5 border-t pt-4',
                theme === 'dark' ? 'border-white/10' : 'border-slate-200/70',
              )}
            >
              <div
                className={cn(
                  'flex gap-2 rounded-2xl border p-1',
                  theme === 'dark'
                    ? 'border-white/5 bg-black/25'
                    : 'border-slate-100/90 bg-[#f8fafc]',
                )}
              >
                {[
                  { id: 'monitor', label: '监控', icon: Scan },
                  { id: 'search', label: '查找', icon: Search },
                  { id: 'track', label: '追踪', icon: Target },
                ].map((mode) => (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => {
                      const next = mode.id as 'monitor' | 'search' | 'track';
                      setActiveMode(next);
                      addLog(`模式切换：${mode.label}模式已激活`, 'info');
                      void (async () => {
                        try {
                          await postJson(APP_CONFIG.api.modePath, { mode: next });
                        } catch (e) {
                          addLog(
                            `! 模式同步 ${e instanceof Error ? e.message : String(e)}`,
                            'warn',
                          );
                        }
                      })();
                    }}
                    className={cn(
                      'flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl py-2.5 text-[10px] font-black uppercase tracking-widest md:min-h-12 md:gap-2 md:py-3',
                      activeMode === mode.id
                        ? 'bg-brand-primary text-white shadow-lg'
                        : cn(
                            theme === 'dark' ? 'text-slate-100' : 'text-slate-900',
                            theme === 'dark'
                              ? 'hover:bg-white/10'
                              : 'hover:bg-slate-200/60',
                          ),
                    )}
                  >
                    <mode.icon
                      className="h-3.5 w-3.5 shrink-0 text-current"
                      aria-hidden
                    />
                    <span className="max-[340px]:sr-only">{mode.label}</span>
                  </button>
                ))}
              </div>

              {activeMode === 'monitor' && (
                <button
                  type="button"
                  onClick={handleResetAlerts}
                  className={cn(
                    'min-h-11 w-full rounded-2xl border py-3 text-[10px] font-black uppercase tracking-widest active:scale-[0.98] md:min-h-12 md:py-3.5',
                    'border-slate-200 bg-[#f8fafc] text-slate-800 dark:border-[#424852] dark:bg-[#32363e] dark:text-slate-200',
                  )}
                >
                  重置系统状态
                </button>
              )}

              {activeMode === 'search' && (
                <div className="flex gap-2">
                  <div
                    className={cn(
                      'flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-[#f8fafc] px-3 transition-all focus-within:ring-2 focus-within:ring-brand-primary/25 sm:gap-3 sm:px-4 dark:border-[#424852] dark:bg-[#32363e]',
                    )}
                  >
                    <Search
                      className="h-4 w-4 shrink-0 text-slate-400"
                      aria-hidden
                    />
                    <input
                      type="search"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="搜索特征或编号..."
                      autoComplete="off"
                      className="min-w-0 flex-1 bg-transparent py-3 text-xs font-bold text-slate-800 placeholder:text-slate-400 focus:outline-none sm:py-3.5 dark:text-slate-200"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void (async () => {
                        try {
                          await postJson(APP_CONFIG.api.searchPath, {
                            query: searchQuery,
                          });
                          addLog(
                            searchQuery
                              ? `查找：已提交「${searchQuery}」`
                              : '查找：已提交（空关键字）',
                            'info',
                          );
                        } catch (e) {
                          addLog(
                            `! 查找 ${e instanceof Error ? e.message : String(e)}`,
                            'warn',
                          );
                        }
                      })();
                    }}
                    className="min-h-11 shrink-0 rounded-2xl bg-brand-primary px-5 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-brand-primary/20 transition-all hover:brightness-110 active:scale-95 sm:px-6"
                  >
                    查找
                  </button>
                </div>
              )}

              {activeMode === 'track' && (
                <button
                  type="button"
                  onClick={() => {
                    void (async () => {
                      try {
                        await postJson(APP_CONFIG.api.trackRefreshPath, {
                          action: 'refresh_track',
                        });
                        addLog('追踪：已请求刷新跟踪状态', 'info');
                      } catch (e) {
                        addLog(
                          `! 追踪刷新 ${e instanceof Error ? e.message : String(e)}`,
                          'warn',
                        );
                      }
                    })();
                  }}
                  className={cn(
                    'flex min-h-11 w-full items-center justify-center gap-3 rounded-2xl border border-slate-200 bg-[#f8fafc] py-3 text-[10px] font-black uppercase tracking-widest text-slate-800 transition-all active:scale-[0.98] md:min-h-12 dark:border-[#424852] dark:bg-[#32363e] dark:text-slate-200',
                  )}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  刷新追踪状态
                </button>
              )}
            </div>
          </section>

          <section className="bento-card relative flex min-h-0 flex-1 basis-0 flex-col overflow-hidden p-3 md:p-4">
            <div className="mb-2 flex shrink-0 items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="rounded-lg bg-brand-primary/10 p-1.5">
                  <Activity className="h-3.5 w-3.5 text-brand-primary" />
                </div>
                <h3
                  className={cn(
                    'text-[10px] font-black uppercase tracking-widest',
                    theme === 'dark' ? 'text-slate-400' : 'text-slate-600',
                  )}
                >
                  监控日志
                </h3>
              </div>
            </div>

            <div
              ref={logContainerRef}
              className={cn(
                'flex min-h-0 flex-1 flex-col overflow-y-auto rounded-2xl border pr-1 custom-scrollbar terminal-scroll',
                theme === 'dark'
                  ? 'border-white/5 bg-black/20'
                  : 'border-slate-200/30 bg-white shadow-[inset_0_1px_0_0_rgba(255,255,255,1)]',
                logsPanelEnabled ? 'px-3 py-2' : '',
                !logsPanelEnabled &&
                  (theme === 'dark' ? 'bg-[#1a1c20]/60' : 'bg-white'),
              )}
            >
              {logsPanelEnabled ? (
                <div className="flex flex-col gap-2.5">
                  <AnimatePresence initial={false}>
                    {logs.slice(-32).map((log) => (
                      <motion.div
                        key={log.id}
                        layout={false}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.12, ease: 'easeOut' }}
                        className="group flex items-start gap-3"
                      >
                        <span
                          className={cn(
                            'mt-0.5 shrink-0 tabular-nums font-mono text-xs font-bold',
                            theme === 'dark' ? 'text-slate-500' : 'text-slate-400',
                          )}
                        >
                          [{log.timestamp}]
                        </span>
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              'text-sm font-bold leading-snug',
                              log.level === 'error'
                                ? 'text-brand-danger'
                                : log.level === 'warn'
                                  ? 'text-amber-600 dark:text-amber-400'
                                : theme === 'dark'
                                  ? 'text-slate-300'
                                  : 'text-slate-800',
                            )}
                          >
                            {log.message}
                          </p>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              ) : (
                <div className="min-h-full grow" aria-hidden />
              )}
            </div>

            {!logsPanelEnabled && (
              <div
                className="absolute inset-0 z-10 flex items-center justify-center p-6 rounded-[inherit] pointer-events-none"
                role="status"
                aria-live="polite"
              >
                <div
                  className="absolute inset-0 rounded-[inherit] border border-white/20 bg-white/15 backdrop-blur-md backdrop-saturate-150 dark:border-white/10 dark:bg-slate-950/20"
                  style={{ borderRadius: 'inherit' }}
                />
                <div className="relative z-10 flex flex-col items-center gap-2 text-center px-4">
                  <Terminal className="h-8 w-8 shrink-0 text-brand-primary" aria-hidden />
                  <p
                    className={cn(
                      'text-base font-black tracking-[0.2em] md:text-lg',
                      theme === 'dark' ? 'text-slate-100' : 'text-slate-900',
                    )}
                  >
                    {t.log_panel_closed}
                  </p>
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      <AnimatePresence>
        {isSettingsOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-[#1a1c20]/60 backdrop-blur-xl"
            onClick={() => setIsSettingsOpen(false)}
            onKeyDown={(e) => e.key === 'Escape' && setIsSettingsOpen(false)}
            role="presentation"
          >
            <motion.div
              initial={{ scale: 0.95, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 20 }}
              className="w-full max-w-lg bg-white dark:bg-[#26292f] rounded-[3rem] shadow-2xl p-10 space-y-10 border border-slate-100 dark:border-white/5"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
            >
              <div className="space-y-2">
                <h2
                  id="settings-title"
                  className="text-3xl font-black tracking-tight text-slate-900 dark:text-white"
                >
                  系统设置
                </h2>
              </div>

              <div className="space-y-6">
                <div className="space-y-3">
                  <label className="pl-1 text-xs font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">
                    {t.host_label}
                  </label>
                  <div className="flex items-center gap-4 bg-slate-50 dark:bg-[#1a1c20] p-4 rounded-3xl border border-slate-200 dark:border-[#3d424b]">
                    <Globe className="h-5 w-5 text-brand-primary" />
                    <input
                      type="text"
                      value={camHost}
                      onChange={(e) => setCamHost(e.target.value)}
                      className="flex-1 bg-transparent text-lg font-mono font-black focus:outline-none placeholder:text-slate-300 dark:placeholder:text-slate-700 text-slate-950 dark:text-white"
                      placeholder="CAMERA IP"
                    />
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4 px-1">
                    <p className="text-xs font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">
                      {t.log_panel_show}
                    </p>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={logsPanelEnabled}
                      onClick={() => setLogsPanelEnabled((v) => !v)}
                      className={cn(
                        'relative h-8 w-14 shrink-0 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#26292f]',
                        logsPanelEnabled
                          ? 'bg-brand-primary'
                          : 'bg-slate-200 dark:bg-slate-600',
                      )}
                    >
                      <span
                        className={cn(
                          'pointer-events-none absolute top-1 left-1 block h-6 w-6 rounded-full bg-white shadow-md ring-1 ring-black/10 transition-transform duration-200 ease-out',
                          logsPanelEnabled ? 'translate-x-6' : 'translate-x-0',
                        )}
                      />
                      <span className="sr-only">{t.log_panel_show}</span>
                    </button>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={handleConnect}
                className="w-full py-6 bg-brand-primary text-white rounded-[2rem] font-black text-sm uppercase tracking-[0.2em] shadow-xl shadow-brand-primary/30 hover:brightness-110 transition-all active:scale-[0.98]"
              >
                应用更改并重连
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {snapshotUrl && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm"
            onClick={() => setSnapshotUrl(null)}
            role="presentation"
          >
            <div
              className="relative max-w-4xl w-full bg-[#1e293b] rounded-[3rem] overflow-hidden shadow-2xl border border-white/10"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
            >
              <div className="p-8 flex items-center justify-between bg-[#111827] border-b border-white/5">
                <div className="flex items-center gap-4">
                  <div className="p-3 bg-brand-primary/20 rounded-2xl">
                    <ShieldCheck className="h-6 w-6 text-brand-primary" />
                  </div>
                  <div>
                    <h3 className="text-white font-black uppercase tracking-widest">
                      快照
                    </h3>
                    <p className="text-xs text-white/40 font-mono">
                      {getCaptureUrl(camHost, camPortNum)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSnapshotUrl(null)}
                  className="p-3 bg-white/5 text-white/40 hover:text-white rounded-2xl transition-colors"
                >
                  <RefreshCw className="h-5 w-5" />
                </button>
              </div>
              <div className="aspect-video bg-black flex items-center justify-center">
                <img
                  src={snapshotUrl}
                  alt="capture"
                  className="max-h-[70vh] w-full object-contain"
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  return <MonitorApp />;
}
