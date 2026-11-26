import { tableFromIPC, tableToIPC } from 'apache-arrow';
import { toGeoArrowTable } from '../dist/geoarrow.js';

self.onmessage = ({ data }) => {
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
