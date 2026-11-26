import { tableFromIPC, tableToIPC } from 'apache-arrow';
import { toGeoArrowTable } from '../dist/geoarrow.js';
import { lineStringViewXY } from '../dist/geometry.js';
import { SharedList } from '../dist/shared.js';

self.onmessage = ({ data }) => {
  if ('row' in data) {
    const original = lineStringViewXY(data.batch, data.row)!;
    const edited = new SharedList('number').pushMany(original).set(2, 9);
    self.postMessage({ original, edited: edited.toFloat64Array() });
    return;
  }
  const table = toGeoArrowTable(data);
  const column = table.getChild('geometry')!.data[0]!;
  const encoded = tableToIPC(table, 'stream');
  const decoded = tableFromIPC(encoded);
  self.postMessage({
    extension: decoded.schema.fields[0].metadata.get('ARROW:extension:name'),
    rows: Array.from(decoded.getChild('geometry')!, line => line && Array.from(line, xy => [...xy])),
    coordinates: column.children[0].children[0].values,
  });
};
