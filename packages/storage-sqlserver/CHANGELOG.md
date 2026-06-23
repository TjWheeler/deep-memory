# @utaba/deep-memory-storage-sqlserver

## 0.20.0

### Minor Changes

- 3e3e4c8: Upgrade `mssql` runtime dependency to v12 (was v11). Consumers sharing a `ConnectionPool` with their own `mssql` install must upgrade to `mssql@12`.

  - `@utaba/deep-memory-storage-sqlserver`: bumped `mssql` to `^12.5.4` and `@types/mssql` to `^12.3.0`. The public surface is unchanged — `SqlServerStorageProviderConfig.connection` still accepts `sql.config | sql.ConnectionPool` and `sql.config` is structurally identical between v11 and v12. Consumers who pass a bare config object are not affected.
  - Breaking surface: consumers who construct their own `sql.ConnectionPool` and pass the instance into the provider must use `mssql@12`. A v11 pool will fail the runtime `instanceof sql.ConnectionPool` check inside the provider.
  - Mssql v12.0.0 stopped cloning config objects on construction (they must now be treated as immutable). The provider does not mutate user-supplied config, so this is transparent to consumers.

### Patch Changes

- Updated dependencies [58be448]
- Updated dependencies [e4d470f]
  - @utaba/deep-memory@0.20.0

## 0.17.0

### Patch Changes

- @utaba/deep-memory@0.17.0
