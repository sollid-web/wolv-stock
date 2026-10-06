"use client";

export default function ParticleCanvas() {
  return (
    <canvas
      className="wolv-particle-canvas"
      ref={(canvas) => {
        if (!canvas || canvas.dataset.init) return;
        canvas.dataset.init = "1";
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const W = (canvas.width = canvas.offsetWidth || 800);
        const H = (canvas.height = canvas.offsetHeight || 600);
        const pts = Array.from({ length: 55 }, () => ({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
          r: Math.random() * 1.5 + 0.4,
        }));
        function draw() {
          ctx!.clearRect(0, 0, W, H);
          for (const p of pts) {
            p.x += p.vx; p.y += p.vy;
            if (p.x < 0 || p.x > W) p.vx *= -1;
            if (p.y < 0 || p.y > H) p.vy *= -1;
            ctx!.beginPath();
            ctx!.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx!.fillStyle = "rgba(240,185,11,0.7)";
            ctx!.fill();
          }
          for (let i = 0; i < pts.length; i++)
            for (let j = i + 1; j < pts.length; j++) {
              const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y;
              const d = Math.sqrt(dx * dx + dy * dy);
              if (d < 120) {
                ctx!.beginPath();
                ctx!.moveTo(pts[i].x, pts[i].y);
                ctx!.lineTo(pts[j].x, pts[j].y);
                ctx!.strokeStyle = `rgba(240,185,11,${0.12 * (1 - d / 120)})`;
                ctx!.lineWidth = 0.5;
                ctx!.stroke();
              }
            }
          requestAnimationFrame(draw);
        }
        draw();
      }}
    />
  );
}
