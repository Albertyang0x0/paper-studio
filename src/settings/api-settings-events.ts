import { useEffect, useRef } from "react";
import type { ApiSettingsStatus } from "../../shared/api-settings";
import { protocolLabels } from '../../shared/api-settings';

const eventName = "paper-studio:api-settings-changed";
const channelName = "paper-studio-api-settings";
export function notifyApiSettingsChanged(status: ApiSettingsStatus) {
  window.dispatchEvent(new CustomEvent(eventName, { detail: status }));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(status);
    channel.close();
  }
}

/** Synchronize the paper page, embedded canvas, standalone canvas and other tabs. */
export function useApiSettingsUpdates(callback: (status: ApiSettingsStatus) => void) {
  const latest = useRef(callback);
  latest.current = callback;
  useEffect(() => {
    const update = (status: ApiSettingsStatus) => {
      if (status?.provider in protocolLabels && typeof status.configured === "boolean") latest.current(status);
    };
    const local = (event: Event) => update((event as CustomEvent<ApiSettingsStatus>).detail);
    window.addEventListener(eventName, local);
    const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(channelName);
    if (channel) channel.onmessage = event => update(event.data);
    return () => { window.removeEventListener(eventName, local); channel?.close(); };
  }, []);
}
