// Imported first by every entry point. grpc-js's own DNS resolver times out on some
// networks (seen on this project's Wi-Fi); the operating system's resolver works.
process.env.GRPC_DNS_RESOLVER ??= "native";
export {};
