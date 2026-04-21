interface AudioLevelMeterProps {
  level: number;
  label: string;
}

const BAR_COUNT = 18;

export function AudioLevelMeter({ level, label }: AudioLevelMeterProps) {
  const clampedLevel = Math.max(0, Math.min(1, level));
  const activeBars = Math.max(1, Math.round(clampedLevel * BAR_COUNT));

  return (
    <section className="panel-subsection">
      <div className="panel-subsection-header">
        <h3>Live audio</h3>
        <p>{label}</p>
      </div>

      <div className="audio-meter" aria-label={label}>
        {Array.from({ length: BAR_COUNT }, (_, index) => {
          const ratio = (index + 1) / BAR_COUNT;
          const isActive = index < activeBars && clampedLevel > 0.02;

          return (
            <span
              key={index}
              className={`audio-meter-bar ${isActive ? "audio-meter-bar-active" : ""}`}
              style={{ height: `${28 + ratio * 44}px` }}
            />
          );
        })}
      </div>
    </section>
  );
}
