interface AudioLevelMeterProps {
  level: number;
  label: string;
}

const BAR_COUNT = 10;

export function AudioLevelMeter({ level, label }: AudioLevelMeterProps) {
  const clampedLevel = Math.max(0, Math.min(1, level));
  const activeBars = Math.max(1, Math.round(clampedLevel * BAR_COUNT));
  const percentage = Math.round(clampedLevel * 100);

  return (
    <div className="mini-audio-meter" aria-label={`${label}: ${percentage}%`} title={label}>
      <span className="mini-audio-meter-label">Audio</span>
      <div className="mini-audio-meter-bars" aria-hidden="true">
        {Array.from({ length: BAR_COUNT }, (_, index) => {
          const ratio = (index + 1) / BAR_COUNT;
          const isActive = index < activeBars && clampedLevel > 0.02;

          return (
            <span
              key={index}
              className={`mini-audio-meter-bar ${isActive ? "mini-audio-meter-bar-active" : ""}`}
              style={{ height: `${4 + ratio * 12}px` }}
            />
          );
        })}
      </div>
      <span className="mini-audio-meter-value">{percentage}%</span>
    </div>
  );
}
