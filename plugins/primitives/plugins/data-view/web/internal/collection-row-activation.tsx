import { useMemo, type ReactNode } from "react";
import type { DataViewRowsCollection } from "../../core";
import {
  foldActivations,
  type ActivationAnswer,
  type CollectionActivation,
} from "./fold-activations";
import {
  DataViewSlots,
  collectionItemActionKey,
  type CollectionRowActivationContribution,
} from "../slots";

// Where a row goes, declared once by its owner
// (`DataViewSlots.CollectionRowActivation`) — a collection's, or one arm's
// of a union (a Meta-DataView dispatches each row to its own source). Each
// owned contribution's hook is called once per DataView, by a level of this
// recursive fold (never a `.map` over hooks), and the levels fold into ONE
// per-row resolver the body hands its own activation to.

const NO_ANSWERS: readonly ActivationAnswer[] = [];

/**
 * Mount every row activation `collection` owns and hand `children` their
 * fold — `undefined` when it owns none (the list's own activation alone).
 */
export function CollectRowActivation(props: {
  collection: DataViewRowsCollection | undefined;
  children: (activation: CollectionActivation | undefined) => ReactNode;
}): ReactNode {
  const { collection, children } = props;
  const all = DataViewSlots.CollectionRowActivation.useContributions();
  const owned = useMemo(
    () =>
      collection === undefined
        ? []
        : all.filter(
            (c) => collectionItemActionKey(c.owner) === collection.key,
          ),
    [all, collection],
  );
  if (collection === undefined || owned.length === 0)
    return children(undefined);
  return (
    <ActivationLevels
      collection={collection}
      pending={owned}
      answers={NO_ANSWERS}
      render={children}
    />
  );
}

function ActivationLevels(props: {
  collection: DataViewRowsCollection;
  pending: readonly CollectionRowActivationContribution[];
  answers: readonly ActivationAnswer[];
  render: (activation: CollectionActivation | undefined) => ReactNode;
}): ReactNode {
  const { collection, pending, answers, render } = props;
  if (pending.length === 0) {
    return (
      <FoldedActivation
        collection={collection}
        answers={answers}
        render={render}
      />
    );
  }
  const [first, ...rest] = pending;
  return (
    <ActivationLevel
      key={first!.id}
      contribution={first!}
      answers={answers}
      render={(next) => (
        <ActivationLevels
          collection={collection}
          pending={rest}
          answers={next}
          render={render}
        />
      )}
    />
  );
}

function ActivationLevel(props: {
  contribution: CollectionRowActivationContribution;
  answers: readonly ActivationAnswer[];
  render: (answers: readonly ActivationAnswer[]) => ReactNode;
}): ReactNode {
  const { contribution, answers, render } = props;
  const { useActivation } = contribution;
  const resolve = useActivation();
  const owner = contribution.owner;
  // Stable while the levels above and this hook's resolver are: the fold's
  // resolver keeps its identity across renders that change neither.
  const next = useMemo(
    (): readonly ActivationAnswer[] => [
      ...answers,
      {
        id: contribution.id,
        arm: "kind" in owner ? owner.owner.arm : null,
        resolve,
      },
    ],
    [answers, contribution.id, owner, resolve],
  );
  return render(next);
}

function FoldedActivation(props: {
  collection: DataViewRowsCollection;
  answers: readonly ActivationAnswer[];
  render: (activation: CollectionActivation | undefined) => ReactNode;
}): ReactNode {
  const { collection, answers, render } = props;
  const activation = useMemo(
    () => foldActivations(collection, answers),
    [collection, answers],
  );
  return render(activation);
}
