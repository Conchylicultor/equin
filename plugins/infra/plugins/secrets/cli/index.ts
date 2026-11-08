// The secrets store's provider, for a host process that runs server code
// WITHOUT booting a graph (an agent process, a `./equin` verb): it names the
// provider itself, `provideHostServicesUnbooted([SecretStore.provide(
// centralSecretStore)])`. Declares no command; a `bin/` reaches it here, since
// only `cli` and `check` rows list `machine`.
export { centralSecretStore, centralSecretStoreFor } from "../machine";
