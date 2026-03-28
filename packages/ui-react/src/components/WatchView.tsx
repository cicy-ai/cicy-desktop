import { useEffect, useRef } from 'react';
import { getSnapshotUrl } from '../lib/client';

export default function WatchView({ winId }: { winId: number }) {
  const imgRef = useRef<HTMLImageElement>(null);
  
  useEffect(() => {
    // Read settings from localStorage or defaults
    const interval = parseInt(localStorage.getItem('ELECTRON_MCP_INTERVAL') || '1000');
    const quality = parseInt(localStorage.getItem('ELECTRON_MCP_QUALITY') || '80');
    const scale = parseFloat(localStorage.getItem('ELECTRON_MCP_SCALE') || '0.5');

    const tick = async () => {
      if (!imgRef.current) return;
      try {
        const url = getSnapshotUrl(winId, quality, scale);
        const res = await fetch(url);
        if (!res.ok) return;
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        
        const oldUrl = imgRef.current.getAttribute('data-object-url');
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        
        imgRef.current.src = objectUrl;
        imgRef.current.setAttribute('data-object-url', objectUrl);
      } catch (e) {
        console.error(e);
      }
    };

    tick();
    const timer = setInterval(tick, interval);
    return () => clearInterval(timer);
  }, [winId]);

  return (
    <div className="w-screen h-screen bg-black overflow-hidden flex items-center justify-center">
      <img ref={imgRef} alt="Live capture" className="w-full h-full object-contain block" />
    </div>
  );
}
