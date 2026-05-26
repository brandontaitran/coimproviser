import { useRef, useEffect, useCallback } from 'react';

const LIFETIME_MS = 2200;

const PALETTE = [
    '#4dd0e1', // teal
    '#e040fb', // magenta
    '#7c4dff', // violet
    '#69f0ae', // mint
    '#ff6d00', // orange
    '#40c4ff', // sky
    '#f50057', // pink-red
    '#b2ff59', // lime
];

export function NoteVisualizer({ callbackRef }) {
    const canvasRef   = useRef(null);
    const blobsRef    = useRef([]);
    const rafRef      = useRef(null);
    const lastTimeRef = useRef(null);

    const spawnBlob = useCallback(({ pitch, velocity }) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const cx = canvas.width  / 2;
        const cy = canvas.height / 2;

        // Burst outward from center; bias upward (angle in upper hemisphere ± spread).
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
        const speed = 70 + Math.random() * 110;

        blobsRef.current.push({
            x:         cx + (Math.random() - 0.5) * 60,
            y:         cy + (Math.random() - 0.5) * 60,
            vx:        Math.cos(angle) * speed * 0.6,
            vy:        Math.sin(angle) * speed,
            radius:    14 + (velocity / 127) * 22,
            color:     PALETTE[pitch % PALETTE.length],
            spawnTime: performance.now(),
        });
    }, []);

    useEffect(() => {
        if (callbackRef) callbackRef.current = spawnBlob;
        return () => { if (callbackRef) callbackRef.current = null; };
    }, [callbackRef, spawnBlob]);

    // Set canvas pixel resolution to its rendered CSS size.
    useEffect(() => {
        const canvas = canvasRef.current;
        canvas.width  = canvas.offsetWidth  || window.innerWidth;
        canvas.height = canvas.offsetHeight || window.innerHeight;
    }, []);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx    = canvas.getContext('2d');

        function frame(now) {
            rafRef.current = requestAnimationFrame(frame);
            const dt = lastTimeRef.current ? (now - lastTimeRef.current) / 1000 : 0;
            lastTimeRef.current = now;

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const alive = [];
            for (const b of blobsRef.current) {
                const age = now - b.spawnTime;
                if (age > LIFETIME_MS) continue;
                const t     = age / LIFETIME_MS;
                const alpha = Math.pow(1 - t, 1.2);
                b.x += b.vx * dt;
                b.y += b.vy * dt;
                alive.push(b);

                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.shadowBlur  = 32;
                ctx.shadowColor = b.color;
                const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.radius);
                grad.addColorStop(0,    '#ffffff');
                grad.addColorStop(0.2,  b.color);
                grad.addColorStop(0.7,  b.color + '88');
                grad.addColorStop(1,    'transparent');
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
            blobsRef.current = alive;
        }

        rafRef.current = requestAnimationFrame(frame);
        return () => {
            cancelAnimationFrame(rafRef.current);
            lastTimeRef.current = null;
        };
    }, []);

    return <canvas ref={canvasRef} className="note-visualizer" />;
}
