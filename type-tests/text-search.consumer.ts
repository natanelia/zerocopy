import { SharedList, type TextSearchOptions } from 'zerocopy';
const options: TextSearchOptions = { caseSensitive: false };
const values = new SharedList('string').push('Request completed');
const matches: (index: number) => boolean = values.compileTextSearch('request', options);
const result: boolean = matches(0);
void result;
// @ts-expect-error Only string lists support text search.
new SharedList('number').compileTextSearch('request');
// @ts-expect-error Search text must be a string.
values.compileTextSearch(/request/);
// @ts-expect-error The predicate accepts a numeric list index.
matches('0');
// @ts-expect-error caseSensitive must be boolean.
values.compileTextSearch('request', { caseSensitive: 'false' });
