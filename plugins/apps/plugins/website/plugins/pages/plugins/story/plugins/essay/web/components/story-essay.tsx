import { useLayoutEffect, useRef } from "react";
import { WebsiteBand } from "@plugins/apps/plugins/website/plugins/shell/web";
import { SkillsGraph } from "@plugins/apps/plugins/website/plugins/pages/plugins/story/plugins/skills-graph/web";
import {
  MindOverload,
  ReviewDesk,
} from "@plugins/apps/plugins/website/plugins/pages/plugins/story/plugins/heads/web";
import {
  ClaudeAfter,
  ClaudeBefore,
  NotionDataView,
} from "@plugins/apps/plugins/website/plugins/pages/plugins/story/plugins/data-views/web";
import {
  ImageGallery,
  useImageViewerTrigger,
} from "@plugins/primitives/plugins/overlay/plugins/image-viewer/web";
import {
  FoldMotion,
  useCollapsible,
} from "@plugins/primitives/plugins/collapsible/web";
import {
  mountBacklog,
  mountFrictionChain,
  mountNewFriction,
} from "../internal/figures";
import { UPDATE_SKILL } from "../internal/update-skill";
import terminalShot from "../shots/terminal-manager.png";
import firstUiShot from "../shots/ui-2026-04-11.png";
import "./story-essay.css";

/**
 * The story of how equin came to be, as one essay: first contact with agents
 * and the skills that taught them to think more like us, the friction loop that
 * built the agent manager, a world without friction, the restart after Google,
 * and the data view as the one primitive reused everywhere.
 *
 * Ported from the prototype `proto-1794207359-w7ez6h` at its default options
 * (`graphs: few` — the figures the story needs). The prose is React; each
 * figure owns the box rendered for it from mount on, as the prototype's
 * scripts owned theirs. Colours are the story palette, read from the site's
 * theme.
 */
export function StoryEssay() {
  return (
    <WebsiteBand section="story" rhythm="page-body">
      <ImageGallery>
        <article className="story-essay">
          <div className="prose">
            <FirstContact />
            <ReduceFriction />
            <NoFriction />
            <AndBeyond />
            <OneApp />
            <div className="tbc">
              <p className="tbc-k">To be continued&hellip;</p>
            </div>
          </div>
        </article>
      </ImageGallery>
    </WebsiteBand>
  );
}

function FirstContact() {
  return (
    <>
      <h2>First contact with AGI</h2>
      <p>
        My first real contact with agents was back in February 2026, with Claude
        Opus 4.6. Two things became obvious very quickly: my job was about to
        change forever, and something that looked like a new form of life was
        emerging.
      </p>
      <p>
        I quickly started testing the limits of what the models of the time
        could do. My goal was to build self-evolving loops through modular,
        connected skills.
      </p>
      <p>
        The idea was simple. When raw Claude fails a task, there are two
        possible reasons:
      </p>
      <ul>
        <li>The model has a fundamental limitation, and cannot do it.</li>
        <li>Claude was not prompted correctly.</li>
      </ul>
      <p>I wanted to see how far the second option could be pushed.</p>
      <p>
        I noticed that when Claude failed, it was often because the agent had
        thought about the problem differently than a human would. So I started
        writing skills that would teach Claude to think more like us: the
        building blocks of cognition.
      </p>

      <figure className="fig">
        <SkillsGraph />
      </figure>

      <p>Two skills formed the foundation of the self-improvement loop.</p>
      <p>
        <strong>Meta-fix.</strong> When you ask for a fix, there are always two
        levels to apply it at: the fix itself, which is what Claude does by
        default, and the meta-fix, whatever allowed the bug to appear in the
        first place. The second one is the most important to get right, because
        it prevents the same class of issue in the future.
      </p>
      <p>
        <strong>Update skill</strong>, probably the most important one. It
        forces Claude into counterfactual reasoning to work out where and how to
        edit its own skills.
      </p>

      <UpdateSkill />
    </>
  );
}

function ReduceFriction() {
  return (
    <>
      <h2>Reduce friction, in a loop</h2>
      <p>
        Most of my work at Google could be summed up in a single objective:{" "}
        <strong>reduce friction.</strong>
      </p>
      <p>
        The loop was: I&rsquo;m trying to do my job, but I get frustrated. A
        workflow takes one extra click; expressing an idea takes too many lines
        of code; &hellip;
      </p>
      <figure className="fig">
        <div className="nest">
          <div className="r">
            <span>Me</span>
            <div className="ln">
              <span className="on">Friction</span>
            </div>
            <span>My job</span>
          </div>
        </div>
      </figure>

      <p>
        I would often spend more time trying to fix the friction, which became
        an objective in itself. And often, fixing that friction came with
        friction of its own.
      </p>

      <figure className="fig">
        <NewFriction />
      </figure>

      <p>
        By doing so, I would produce libraries and artifacts I could share with
        the team (some of which grew beyond my team, to be used by the rest of
        Google).
      </p>
      <p>
        Working with agents quickly became exhausting. You constantly multitask,
        keep the individual workstreams in your head, and switch between
        conversations all day. At the time I had five or six conversations
        running in parallel.
      </p>

      <figure className="fig">
        <MindOverload />
      </figure>

      <p>
        As usual when I feel friction in my work, I embarked on a quest to fix
        the tooling, so I could work smoothly again.
      </p>
      <p>
        Since I had access to the agent manager&rsquo;s source code (an internal
        version of Google&rsquo;s Antigravity), I started injecting a custom
        plugin system into it, to try out new UI ideas. The goal was a UI that
        would let me launch and monitor agents without the mental overhead.
      </p>

      <p>
        I did not really have an end vision: each piece emerged organically from
        trying to fix the previous one.
      </p>

      <p>
        This is when I started building the core pieces that would later evolve
        into equin:
      </p>
      <ul>
        <li>
          <strong>A gateway that auto-restarts deployments:</strong> each agent
          deploys an isolated, self-contained version of the app, so I can test
          changes before merging.
        </li>
        <li>
          <strong>A plugin system:</strong> each feature is self-contained and
          independent.
        </li>
        <li>
          <strong>A task/queue system:</strong> connecting the TODOs directly to
          the agent manager. This was the key to removing the mental overhead.
        </li>
      </ul>

      <figure className="fig">
        <FrictionChain />
      </figure>
    </>
  );
}

function NoFriction() {
  return (
    <>
      <h2>A world without friction</h2>
      <p>
        In every project I have ever had, there is more to do than humans can
        accomplish. Tasks accumulate in an ever-growing list.
      </p>
      <p>
        What happens when there is no more friction? All thoughts become
        reality, instantly.
      </p>
      <p>
        A system that resolves TODOs faster than they are created: that is what
        I was trying to build.
      </p>

      <figure className="fig">
        <Backlog />
      </figure>

      <p>
        Many changes were needed to remove friction, but the main workflow could
        be summarized as:
      </p>
      <ul>
        <li>
          <strong>No more backlog:</strong> every task, issue or feature is a
          prompt, launched instantly in the background, so every task gets done.
        </li>
        <li>
          <strong>A review queue,</strong> so I never lose track of the tasks I
          launched. I never have to keep the state of a conversation in my head.
        </li>
      </ul>

      <figure className="fig">
        <ReviewDesk />
      </figure>

      <p>
        I felt I was creating the pieces of something powerful, and I wanted to
        keep ownership of it. At the time, I was on the Gemma team. I remember
        exactly: the Gemma 4 release (April 2, 2026) was the day the pieces I
        was building started to click together. I felt like, holy shit, what I
        was building was actually working. I remember the whole team celebrating
        the release, but I felt so disconnected from it, as if I was living in
        another world. All the projects I had ever worked on at Google belonged
        to the past.
      </p>
      <p>One week later, I handed in my resignation.</p>
    </>
  );
}

function AndBeyond() {
  return (
    <>
      <h2>And beyond</h2>
      <p>
        I spent my first weeks after leaving Google recreating my agent manager.
        The one I was using at Google, like all the code I had written, belonged
        to Google. So I had to start from scratch.
      </p>
      <p>
        I started by reimplementing the core ideas as a small terminal-based
        agent manager, so I could manage multiple Claude Code sessions without
        the mental overhead.
      </p>
      <Shot
        src={terminalShot}
        name="My first terminal-based agent manager"
        alt="A terminal list of Claude Code sessions, with New session and Resume session"
      />
      <p>
        Then I thought about building my agent manager on top of an existing
        IDE, like VS Code, but quickly realized I was fighting the IDE&rsquo;s
        abstractions. So I started a greenfield project instead, to have full
        freedom.
      </p>
      <Shot
        src={firstUiShot}
        name="The first versions of the UI were just wrappers around Claude Code"
        alt="April 11: a sidebar of Claude sessions next to a Claude Code terminal"
      />
      <p>
        This second version was much more structured and principled than the one
        I had at Google. I was moving really fast. Within a week, I had a
        working prototype.
      </p>
      <p>
        From there, the app grew organically. Each prompt simply fixed whatever
        friction I was having with the app at that moment.
      </p>
      <ul>
        <li>
          Claude makes my app crash &rarr; Add a crash report and monitoring
          system
        </li>
        <li>
          My app is unavailable every time Claude restarts it &rarr; Add
          blue-green deployment
        </li>
        <li>
          Claude struggles to design good UI &rarr; Create an app to prototype
          UIs
        </li>
      </ul>
      <p>
        With friction removed, I felt like I was in a constant productivity
        flow. That&rsquo;s where I started to think about applying the building
        blocks I had built for my agent manager to other applications: reducing
        the friction in all the applications I&rsquo;m using. The beginning of
        my custom operating system.
      </p>
    </>
  );
}

function OneApp() {
  return (
    <>
      <h2>One app to rule them all</h2>
      <p>
        Before agents, I was a heavy user of Notion. Back in 2021, I started
        having a dream, something I could only make real with a billion dollars
        to pay an entire engineering team for years. What if Notion&rsquo;s
        building-block idea were generalized and applied to the entire operating
        system?
      </p>
      <p>
        Notion&rsquo;s main power comes from the data view: a very generic
        primitive that can be customized to create mini apps. At its core, a
        data view is just a way to show the same data with:
      </p>
      <ul>
        <li>Custom filters</li>
        <li>Custom sort</li>
        <li>Custom rendering (list, table, gallery)</li>
      </ul>
      <div className="wide">
        <NotionDataView />
      </div>
      <p>
        Once I used data views, I wished they were everywhere. Take the Claude
        app for instance. The sidebar and the Artifacts page are both incomplete
        reimplementations of Notion&rsquo;s data views, creating duplication and
        inconsistency.
      </p>

      <div className="wide">
        <ClaudeBefore />
      </div>
      <p>
        My idea:{" "}
        <strong>
          implement the primitive well once, and reuse it everywhere.
        </strong>{" "}
        If I add infinite scrolling, every surface of every app, current and
        future, supports it. If I fix a bug, every app is fixed.
      </p>

      <div className="wide">
        <ClaudeAfter />
      </div>

      <p>
        Data view was just one primitive, but I applied this principle to
        everything: build the building block once, cleanly, so it can be reused
        in every application, present and future.
      </p>
      <p>
        What started as a project to help me manage my agents became an
        experiment: can I reimplement every app I use, shaped exactly the way I
        wish it had been designed?
      </p>
    </>
  );
}

/** The update skill, in full: a card that folds open to the skill's text. */
function UpdateSkill() {
  const { open, triggerProps, contentProps } = useCollapsible();
  return (
    <div className="details" data-open={open}>
      <button className="summary" {...triggerProps}>
        The update skill, in full{" "}
        <span className="meta">skills are a program graph</span>
      </button>
      <FoldMotion {...contentProps}>
        <pre>{UPDATE_SKILL}</pre>
      </FoldMotion>
    </div>
  );
}

/** A screenshot with its caption; a click opens it whole in the app's image viewer. */
function Shot({ src, name, alt }: { src: string; name: string; alt: string }) {
  const trigger = useImageViewerTrigger<HTMLImageElement>({ src, name, alt });
  return (
    <figure className="shot">
      <img src={src} alt={alt} {...trigger} />
      <figcaption>{name}</figcaption>
    </figure>
  );
}

/** "Me → Friction": once on screen, a new friction lands on the line. */
function NewFriction() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () => (ref.current ? mountNewFriction(ref.current) : undefined),
    [],
  );
  return (
    <div className="nest" ref={ref}>
      <div className="r">
        <span>Me</span>
        <div className="ln" />
        <span className="hl">Friction</span>
      </div>
    </div>
  );
}

/** The friction chain: click a friction and it becomes the next objective; the last one unwinds the stack. */
function FrictionChain() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () => (ref.current ? mountFrictionChain(ref.current) : undefined),
    [],
  );
  return <div className="nest chain" ref={ref} />;
}

/** The backlog: the same tasks pile up on the left, and are done and gone on the right. */
function Backlog() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () => (ref.current ? mountBacklog(ref.current) : undefined),
    [],
  );
  return (
    <div className="sides" ref={ref}>
      <div className="side">
        <h4>
          Task list <span data-n="">0 open</span>
        </h4>
        <div className="rowsbox" data-list="" />
        <div className="more" data-more="" hidden />
      </div>
      <div className="side">
        <h4>
          Agents + no friction{" "}
          <span className="hl" data-n="">
            0 open
          </span>
        </h4>
        <div className="rowsbox" data-list="" />
      </div>
    </div>
  );
}
