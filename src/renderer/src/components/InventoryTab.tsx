import type { InventoryRecord } from '../../../shared/types'

interface Props {
  records: InventoryRecord[]
}

export function InventoryTab({ records }: Props) {
  if (!records.length) {
    return (
      <div className="panel">
        <h2>Inventory</h2>
        <p className="muted">No downloads yet.</p>
      </div>
    )
  }

  return (
    <div className="panel">
      <h2>Downloaded models ({records.length})</h2>
      <table>
        <thead>
          <tr>
            <th>Slug</th>
            <th>Model</th>
            <th>Version</th>
            <th>Base</th>
            <th>Tag</th>
            <th>Downloaded</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.versionId}>
              <td>{r.slug}</td>
              <td>{r.modelName}</td>
              <td>{r.versionName}</td>
              <td>{r.baseModel}</td>
              <td>{r.routingTag || '—'}</td>
              <td>{new Date(r.downloadedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
