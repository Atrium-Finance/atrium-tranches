import chai from "chai";
import chaiAsPromised from "chai-as-promised";

let initialized = false;
export function setupChai() {
  if (initialized) return chai;
  chai.use(chaiAsPromised);
  initialized = true;
  return chai;
}

setupChai();
export const expect = chai.expect;
