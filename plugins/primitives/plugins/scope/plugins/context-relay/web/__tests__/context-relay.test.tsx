import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  RelayCapture,
  RelayProvide,
  createRelayLink,
  relayOf,
} from "../internal/context-relay";

afterEach(cleanup);

const Count = createContext(-1);
const Name = createContext("none");
const relays = [relayOf(Count), relayOf(Name)];

function Show() {
  return <p>{`${useContext(Name)} ${useContext(Count)}`}</p>;
}

describe("context relay", () => {
  it("shows the fallback until captured, then the host's values, following changes", () => {
    const link = createRelayLink();
    const host = { bump: () => {} };
    function Host({ children }: { children?: ReactNode }) {
      const [n, setN] = useState(1);
      useEffect(() => {
        host.bump = () => setN((x) => x + 1);
      });
      return (
        <Count.Provider value={n}>
          <Name.Provider value="host">
            <RelayCapture link={link} relays={relays} />
            {children}
          </Name.Provider>
        </Count.Provider>
      );
    }
    const view = (
      <RelayProvide link={link} fallback={<p>loading</p>}>
        <Show />
      </RelayProvide>
    );
    // The view is mounted before the host: the fallback first.
    const { rerender } = render(<div>{view}</div>);
    expect(screen.getByText("loading")).toBeTruthy();
    rerender(
      <div>
        {view}
        <Host />
      </div>,
    );
    expect(screen.getByText("host 1")).toBeTruthy();
    act(() => host.bump());
    expect(screen.getByText("host 2")).toBeTruthy();
  });

  it("keeps the last values once the view detaches and re-attaches", () => {
    const link = createRelayLink();
    function Host() {
      return (
        <Count.Provider value={7}>
          <RelayCapture link={link} relays={[relayOf(Count)]} />
        </Count.Provider>
      );
    }
    const { rerender } = render(<Host />);
    rerender(
      <>
        <Host />
        <RelayProvide link={link} fallback={null}>
          <Show />
        </RelayProvide>
      </>,
    );
    expect(screen.getByText("none 7")).toBeTruthy();
  });
});
