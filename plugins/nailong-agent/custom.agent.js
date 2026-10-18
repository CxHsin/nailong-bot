import { agent as defaults, connect } from "./agent.js";

// Launch both Magpie and Nailong with the same NAILONG_MAGPIE_CONFIG override.
export const agent = { ...defaults, config: "$NAILONG_MAGPIE_CONFIG", dir: "$NAILONG_MAGPIE_CONFIG/.." };
export { connect };
