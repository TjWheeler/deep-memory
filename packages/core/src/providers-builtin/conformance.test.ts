// Run the conformance test suite against InMemoryStorageProvider

import { InMemoryStorageProvider } from './InMemoryStorageProvider.js';
import { runStorageProviderConformanceTests } from './conformance.js';

runStorageProviderConformanceTests(() => new InMemoryStorageProvider());
