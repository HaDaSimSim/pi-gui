// Remote control settings: enable/disable, QR pairing, and paired-device
// management. Localhost-only endpoints (configured from the trusted desktop UI).
// See docs/remote-control-design.md §5.

import QRCode from 'qrcode';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { api, type RemoteDevice, type RemoteQrPayload, type RemoteStatus } from './api';
import { useT } from './i18n';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-semibold">{children}</h2>;
}

export function RemotePanel() {
  const { t } = useT();
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ qr: RemoteQrPayload; dataUrl: string } | null>(null);

  const load = useCallback(() => {
    api
      .remoteStatus()
      .then(setStatus)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(load, [load]);

  // Poll while a pairing QR is shown so the device flips pending→active live.
  useEffect(() => {
    if (!pairing) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [pairing, load]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (on) {
        const r = await api.remoteEnable();
        if (r.serveError) setError(t('settings.remoteServeWarn', { error: r.serveError }));
      } else {
        await api.remoteDisable();
      }
      load();
    } catch (e: any) {
      // Surface the "no tailscale" case with a friendly message.
      if (String(e).includes('no_tailnet_host')) setError(t('settings.remoteNoTailscale'));
      else setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addDevice = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.remotePairInit('device');
      const dataUrl = await QRCode.toDataURL(JSON.stringify(r.qr), { width: 320, margin: 2 });
      setPairing({ qr: r.qr, dataUrl });
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await api.remoteRevokeDevice(id);
    load();
  };

  const enabled = status?.enabled ?? false;
  const active = status?.active ?? false;
  const devices = status?.devices ?? [];
  const activeCount = devices.filter((d) => d.status === 'active').length;

  return (
    <>
      <SectionTitle>{t('settings.remote')}</SectionTitle>
      <p className="text-xs text-muted-foreground -mt-3">{t('settings.remoteDesc')}</p>

      <label htmlFor="remote-enable" className="flex items-center justify-between gap-4">
        <div className="flex flex-col">
          <span className="text-sm font-medium">{t('settings.remoteEnable')}</span>
          <span className="text-xs text-muted-foreground">
            {active
              ? t('settings.remoteActive', { n: activeCount })
              : enabled
                ? t('settings.remoteInactive')
                : t('settings.remoteDisabled')}
          </span>
        </div>
        <Switch id="remote-enable" checked={enabled} disabled={busy} onCheckedChange={toggle} />
      </label>

      {status?.tailnetHost ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t('settings.remoteHost')}:</span>
          <code className="rounded bg-muted px-1.5 py-0.5">{status.tailnetHost}</code>
        </div>
      ) : null}

      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">
          {t('settings.remoteDevices')}{' '}
          <span className="text-muted-foreground">({devices.length})</span>
        </div>
        <Button size="sm" onClick={addDevice} disabled={busy || !enabled}>
          {t('settings.remoteAddDevice')}
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {devices.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t('settings.remoteNoDevices')}</div>
        ) : (
          devices.map((d) => <DeviceRow key={d.id} device={d} onRevoke={() => revoke(d.id)} />)
        )}
      </div>

      <Dialog open={!!pairing} onOpenChange={(o) => !o && setPairing(null)}>
        <DialogContent className="max-w-sm">
          <DialogTitle>{t('settings.remoteAddDevice')}</DialogTitle>
          {pairing ? (
            <div className="flex flex-col items-center gap-3">
              <img
                src={pairing.dataUrl}
                alt="pairing QR"
                className="rounded-lg border bg-white p-2"
                width={320}
                height={320}
              />
              <p className="text-center text-xs text-muted-foreground">
                {t('settings.remoteScanHint')}
              </p>
              <code className="w-full truncate rounded bg-muted px-2 py-1 text-center text-xs">
                {pairing.qr.url}
              </code>
              <Button variant="outline" size="sm" onClick={() => setPairing(null)}>
                {t('settings.remoteClose')}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function DeviceRow({ device, onRevoke }: { device: RemoteDevice; onRevoke: () => void }) {
  const { t } = useT();
  const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{device.name}</span>
          <Badge variant={device.status === 'active' ? 'default' : 'secondary'}>
            {device.status === 'active'
              ? t('settings.remoteActiveTag')
              : t('settings.remotePending')}
          </Badge>
        </div>
        {lastSeen ? (
          <span className="text-xs text-muted-foreground">
            {t('settings.remoteLastSeen', { time: lastSeen })}
          </span>
        ) : null}
      </div>
      <Button variant="ghost" size="sm" onClick={onRevoke}>
        {t('settings.remoteRevoke')}
      </Button>
    </div>
  );
}
