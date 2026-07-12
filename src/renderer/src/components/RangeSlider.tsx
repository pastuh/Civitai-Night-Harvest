interface Props {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  formatValue?: (value: number) => string
}

export function RangeSlider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  formatValue
}: Props) {
  const display = formatValue ? formatValue(value) : String(value)

  return (
    <div className="range-slider-field">
      <div className="range-slider-head">
        <label className="field-label">{label}</label>
        <span className="range-slider-value">{display}</span>
      </div>
      <input
        type="range"
        className="range-slider-input"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  )
}
