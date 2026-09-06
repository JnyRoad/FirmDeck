import { useEffect } from 'react';

import { useAppIntl } from '@/i18n/useAppIntl';

import FirmdeckIcon, { type FirmdeckIconName } from '../components/FirmdeckIcon';

type TocGroup = {
  title: string;
  items: Array<{ id: string; label: string }>;
};

type Feature = {
  title: string;
  subtitle: string;
  body: string;
  icon: FirmdeckIconName;
  proof: string;
};

type QuickStep = {
  title: string;
  body: string;
  outcome: string;
};

type Scenario = {
  title: string;
  body: string;
  stack: string;
  tags: string[];
};

type TutorialCopy = {
  docEyebrow: string;
  heroTitle: string;
  heroBody: string;
  primaryAction: string;
  secondaryAction: string;
  proofRow: [string, string, string];
  runtimeMapAria: string;
  runtimeMapLabel: string;
  runtimeMapStages: [string, string, string];
  navAria: string;
  navTitle: string;
  navSubtitle: string;
  tocGroups: TocGroup[];
  introEyebrow: string;
  introTitle: string;
  introBody: string;
  painPoints: string[];
  installEyebrow: string;
  installTitle: string;
  installBody: string;
  installCards: Array<{ title: string; command: string; body: string }>;
  quickStartEyebrow: string;
  quickStartTitle: string;
  quickStartBody: string;
  quickSteps: QuickStep[];
  featuresEyebrow: string;
  featuresTitle: string;
  featuresBody: string;
  features: Feature[];
  runtimeEyebrow: string;
  runtimeTitle: string;
  runtimeBody: string;
  runtimeSteps: string[];
  governanceEyebrow: string;
  governanceTitle: string;
  governanceBody: string;
  governanceItems: string[];
  architectureEyebrow: string;
  architectureTitle: string;
  architectureBody: string;
  architectureLayers: Array<[string, string]>;
  flowEyebrow: string;
  flowTitle: string;
  flowBody: string;
  flowCode: string;
  referenceEyebrow: string;
  referenceTitle: string;
  referenceBody: string;
  referenceItems: string[];
  developmentEyebrow: string;
  developmentTitle: string;
  developmentBody: string;
  developmentItems: Array<{ command: string; body: string }>;
  showcaseEyebrow: string;
  showcaseTitle: string;
  showcaseBody: string;
  scenarios: Scenario[];
  faqEyebrow: string;
  faqTitle: string;
  faqBody: string;
  faqItems: Array<{ question: string; answer: string; open?: boolean }>;
};

/** 构造教程页的语义文案，保持布局配置不变并把所有产品消息收敛到 catalog。 */
function buildTutorialCopy(translate: ReturnType<typeof useAppIntl>['t']): TutorialCopy {
  return {
    docEyebrow: translate('tutorialPage.docEyebrow'),
    heroTitle: translate('tutorialPage.hero.title'),
    heroBody: translate('tutorialPage.hero.body'),
    primaryAction: translate('tutorialPage.hero.primaryAction'),
    secondaryAction: translate('tutorialPage.hero.secondaryAction'),
    proofRow: [
      translate('tutorialPage.hero.proof.modules'),
      translate('tutorialPage.hero.proof.runtimeSteps'),
      translate('tutorialPage.hero.proof.scenarios'),
    ],
    runtimeMapAria: translate('tutorialPage.hero.runtimeMapAria'),
    runtimeMapLabel: translate('tutorialPage.hero.runtimeMapLabel'),
    runtimeMapStages: [
      translate('tutorialPage.hero.runtimeStage.conversation'),
      translate('tutorialPage.hero.runtimeStage.workflow'),
      translate('tutorialPage.hero.runtimeStage.operations'),
    ],
    navAria: translate('tutorialPage.navigation.ariaLabel'),
    navTitle: translate('tutorialPage.navigation.title'),
    navSubtitle: translate('tutorialPage.navigation.subtitle'),
    tocGroups: [
      {
        title: translate('tutorialPage.navigation.group.gettingStarted'),
        items: [
          { id: 'intro', label: translate('tutorialPage.navigation.item.intro') },
          { id: 'install', label: translate('tutorialPage.navigation.item.install') },
          { id: 'quickstart', label: translate('tutorialPage.navigation.item.quickStart') },
        ],
      },
      {
        title: translate('tutorialPage.navigation.group.coreFeatures'),
        items: [
          { id: 'core-features', label: translate('tutorialPage.navigation.item.capabilities') },
          { id: 'runtime', label: translate('tutorialPage.navigation.item.runtime') },
          { id: 'governance', label: translate('tutorialPage.navigation.item.governance') },
        ],
      },
      {
        title: translate('tutorialPage.navigation.group.architecture'),
        items: [
          { id: 'architecture', label: translate('tutorialPage.navigation.item.architecture') },
          { id: 'flow', label: translate('tutorialPage.navigation.item.flow') },
        ],
      },
      {
        title: translate('tutorialPage.navigation.group.reference'),
        items: [
          { id: 'reference', label: translate('tutorialPage.navigation.item.reference') },
          { id: 'development', label: translate('tutorialPage.navigation.item.development') },
          { id: 'showcase', label: translate('tutorialPage.navigation.item.showcase') },
          { id: 'faq', label: translate('tutorialPage.navigation.item.faq') },
        ],
      },
    ],
    introEyebrow: translate('tutorialPage.intro.eyebrow'),
    introTitle: translate('tutorialPage.intro.title'),
    introBody: translate('tutorialPage.intro.body'),
    painPoints: [
      translate('tutorialPage.intro.painPoint.people'),
      translate('tutorialPage.intro.painPoint.knowledge'),
      translate('tutorialPage.intro.painPoint.tools'),
      translate('tutorialPage.intro.painPoint.review'),
    ],
    installEyebrow: translate('tutorialPage.install.eyebrow'),
    installTitle: translate('tutorialPage.install.title'),
    installBody: translate('tutorialPage.install.body'),
    installCards: [
      {
        title: translate('tutorialPage.install.card.start.title'),
        command: 'scripts/dev_up.sh',
        body: translate('tutorialPage.install.card.start.body'),
      },
      {
        title: translate('tutorialPage.install.card.detach.title'),
        command: 'DETACH=1 scripts/dev_up.sh',
        body: translate('tutorialPage.install.card.detach.body'),
      },
      {
        title: translate('tutorialPage.install.card.status.title'),
        command: 'scripts/dev_status.sh',
        body: translate('tutorialPage.install.card.status.body'),
      },
      {
        title: translate('tutorialPage.install.card.stop.title'),
        command: 'scripts/dev_down.sh',
        body: translate('tutorialPage.install.card.stop.body'),
      },
    ],
    quickStartEyebrow: translate('tutorialPage.quickStart.eyebrow'),
    quickStartTitle: translate('tutorialPage.quickStart.title'),
    quickStartBody: translate('tutorialPage.quickStart.body'),
    quickSteps: [
      {
        title: translate('tutorialPage.quickStart.step.foundation.title'),
        body: translate('tutorialPage.quickStart.step.foundation.body'),
        outcome: translate('tutorialPage.quickStart.step.foundation.outcome'),
      },
      {
        title: translate('tutorialPage.quickStart.step.role.title'),
        body: translate('tutorialPage.quickStart.step.role.body'),
        outcome: translate('tutorialPage.quickStart.step.role.outcome'),
      },
      {
        title: translate('tutorialPage.quickStart.step.knowledge.title'),
        body: translate('tutorialPage.quickStart.step.knowledge.body'),
        outcome: translate('tutorialPage.quickStart.step.knowledge.outcome'),
      },
      {
        title: translate('tutorialPage.quickStart.step.tools.title'),
        body: translate('tutorialPage.quickStart.step.tools.body'),
        outcome: translate('tutorialPage.quickStart.step.tools.outcome'),
      },
      {
        title: translate('tutorialPage.quickStart.step.testing.title'),
        body: translate('tutorialPage.quickStart.step.testing.body'),
        outcome: translate('tutorialPage.quickStart.step.testing.outcome'),
      },
      {
        title: translate('tutorialPage.quickStart.step.review.title'),
        body: translate('tutorialPage.quickStart.step.review.body'),
        outcome: translate('tutorialPage.quickStart.step.review.outcome'),
      },
    ],
    featuresEyebrow: translate('tutorialPage.features.eyebrow'),
    featuresTitle: translate('tutorialPage.features.title'),
    featuresBody: translate('tutorialPage.features.body'),
    features: [
      {
        title: translate('tutorialPage.features.item.employees.title'),
        subtitle: translate('tutorialPage.features.item.employees.subtitle'),
        body: translate('tutorialPage.features.item.employees.body'),
        icon: 'user',
        proof: translate('tutorialPage.features.item.employees.proof'),
      },
      {
        title: translate('tutorialPage.features.item.knowledge.title'),
        subtitle: translate('tutorialPage.features.item.knowledge.subtitle'),
        body: translate('tutorialPage.features.item.knowledge.body'),
        icon: 'database',
        proof: translate('tutorialPage.features.item.knowledge.proof'),
      },
      {
        title: translate('tutorialPage.features.item.skills.title'),
        subtitle: translate('tutorialPage.features.item.skills.subtitle'),
        body: translate('tutorialPage.features.item.skills.body'),
        icon: 'spark',
        proof: translate('tutorialPage.features.item.skills.proof'),
      },
      {
        title: translate('tutorialPage.features.item.sops.title'),
        subtitle: translate('tutorialPage.features.item.sops.subtitle'),
        body: translate('tutorialPage.features.item.sops.body'),
        icon: 'filter',
        proof: translate('tutorialPage.features.item.sops.proof'),
      },
      {
        title: translate('tutorialPage.features.item.tools.title'),
        subtitle: translate('tutorialPage.features.item.tools.subtitle'),
        body: translate('tutorialPage.features.item.tools.body'),
        icon: 'tool',
        proof: translate('tutorialPage.features.item.tools.proof'),
      },
      {
        title: translate('tutorialPage.features.item.memory.title'),
        subtitle: translate('tutorialPage.features.item.memory.subtitle'),
        body: translate('tutorialPage.features.item.memory.body'),
        icon: 'history',
        proof: translate('tutorialPage.features.item.memory.proof'),
      },
      {
        title: translate('tutorialPage.features.item.schedules.title'),
        subtitle: translate('tutorialPage.features.item.schedules.subtitle'),
        body: translate('tutorialPage.features.item.schedules.body'),
        icon: 'clock',
        proof: translate('tutorialPage.features.item.schedules.proof'),
      },
      {
        title: translate('tutorialPage.features.item.trace.title'),
        subtitle: translate('tutorialPage.features.item.trace.subtitle'),
        body: translate('tutorialPage.features.item.trace.body'),
        icon: 'eye',
        proof: translate('tutorialPage.features.item.trace.proof'),
      },
    ],
    runtimeEyebrow: translate('tutorialPage.runtime.eyebrow'),
    runtimeTitle: translate('tutorialPage.runtime.title'),
    runtimeBody: translate('tutorialPage.runtime.body'),
    runtimeSteps: [
      translate('tutorialPage.runtime.step.userMessage'),
      translate('tutorialPage.runtime.step.routerDecision'),
      translate('tutorialPage.runtime.step.sopProgression'),
      translate('tutorialPage.runtime.step.knowledgeAndTools'),
      translate('tutorialPage.runtime.step.responseGeneration'),
      translate('tutorialPage.runtime.step.traceFeedbackMemory'),
    ],
    governanceEyebrow: translate('tutorialPage.governance.eyebrow'),
    governanceTitle: translate('tutorialPage.governance.title'),
    governanceBody: translate('tutorialPage.governance.body'),
    governanceItems: [
      translate('tutorialPage.governance.item.logs'),
      translate('tutorialPage.governance.item.trace'),
      translate('tutorialPage.governance.item.feedback'),
      translate('tutorialPage.governance.item.memory'),
      translate('tutorialPage.governance.item.schedules'),
      translate('tutorialPage.governance.item.marketplace'),
    ],
    architectureEyebrow: translate('tutorialPage.architecture.eyebrow'),
    architectureTitle: translate('tutorialPage.architecture.title'),
    architectureBody: translate('tutorialPage.architecture.body'),
    architectureLayers: [
      [
        translate('tutorialPage.architecture.layer.entry.title'),
        translate('tutorialPage.architecture.layer.entry.body'),
      ],
      [
        translate('tutorialPage.architecture.layer.configuration.title'),
        translate('tutorialPage.architecture.layer.configuration.body'),
      ],
      [
        translate('tutorialPage.architecture.layer.runtime.title'),
        translate('tutorialPage.architecture.layer.runtime.body'),
      ],
      [
        translate('tutorialPage.architecture.layer.context.title'),
        translate('tutorialPage.architecture.layer.context.body'),
      ],
      [
        translate('tutorialPage.architecture.layer.observability.title'),
        translate('tutorialPage.architecture.layer.observability.body'),
      ],
    ],
    flowEyebrow: translate('tutorialPage.flow.eyebrow'),
    flowTitle: translate('tutorialPage.flow.title'),
    flowBody: translate('tutorialPage.flow.body'),
    flowCode: translate('tutorialPage.flow.code'),
    referenceEyebrow: translate('tutorialPage.reference.eyebrow'),
    referenceTitle: translate('tutorialPage.reference.title'),
    referenceBody: translate('tutorialPage.reference.body'),
    referenceItems: [
      translate('tutorialPage.reference.item.models'),
      translate('tutorialPage.reference.item.employees'),
      translate('tutorialPage.reference.item.knowledge'),
      translate('tutorialPage.reference.item.sops'),
      translate('tutorialPage.reference.item.tools'),
      translate('tutorialPage.reference.item.operations'),
    ],
    developmentEyebrow: translate('tutorialPage.development.eyebrow'),
    developmentTitle: translate('tutorialPage.development.title'),
    developmentBody: translate('tutorialPage.development.body'),
    developmentItems: [
      {
        command: 'scripts/dev_status.sh',
        body: translate('tutorialPage.development.item.status'),
      },
      {
        command: 'scripts/dev_down.sh',
        body: translate('tutorialPage.development.item.stop'),
      },
      {
        command: 'cd backend && .venv/bin/pytest',
        body: translate('tutorialPage.development.item.backendTests'),
      },
      {
        command: 'cd frontend-enterprise && npm run build',
        body: translate('tutorialPage.development.item.frontendBuild'),
      },
    ],
    showcaseEyebrow: translate('tutorialPage.showcase.eyebrow'),
    showcaseTitle: translate('tutorialPage.showcase.title'),
    showcaseBody: translate('tutorialPage.showcase.body'),
    scenarios: [
      {
        title: translate('tutorialPage.showcase.item.afterSales.title'),
        body: translate('tutorialPage.showcase.item.afterSales.body'),
        stack: translate('tutorialPage.showcase.item.afterSales.stack'),
        tags: [
          translate('tutorialPage.showcase.item.afterSales.tag.order'),
          translate('tutorialPage.showcase.item.afterSales.tag.eligibility'),
          translate('tutorialPage.showcase.item.afterSales.tag.handoff'),
        ],
      },
      {
        title: translate('tutorialPage.showcase.item.shopping.title'),
        body: translate('tutorialPage.showcase.item.shopping.body'),
        stack: translate('tutorialPage.showcase.item.shopping.stack'),
        tags: [
          translate('tutorialPage.showcase.item.shopping.tag.knowledge'),
          translate('tutorialPage.showcase.item.shopping.tag.pricing'),
          translate('tutorialPage.showcase.item.shopping.tag.purchase'),
        ],
      },
      {
        title: translate('tutorialPage.showcase.item.operations.title'),
        body: translate('tutorialPage.showcase.item.operations.body'),
        stack: translate('tutorialPage.showcase.item.operations.stack'),
        tags: [
          translate('tutorialPage.showcase.item.operations.tag.cron'),
          translate('tutorialPage.showcase.item.operations.tag.weeklyReport'),
          translate('tutorialPage.showcase.item.operations.tag.followUp'),
        ],
      },
      {
        title: translate('tutorialPage.showcase.item.knowledgeAssistant.title'),
        body: translate('tutorialPage.showcase.item.knowledgeAssistant.body'),
        stack: translate('tutorialPage.showcase.item.knowledgeAssistant.stack'),
        tags: [
          translate('tutorialPage.showcase.item.knowledgeAssistant.tag.policy'),
          translate('tutorialPage.showcase.item.knowledgeAssistant.tag.citation'),
          translate('tutorialPage.showcase.item.knowledgeAssistant.tag.wording'),
        ],
      },
    ],
    faqEyebrow: translate('tutorialPage.faq.eyebrow'),
    faqTitle: translate('tutorialPage.faq.title'),
    faqBody: translate('tutorialPage.faq.body'),
    faqItems: [
      {
        question: translate('tutorialPage.faq.item.model.question'),
        answer: translate('tutorialPage.faq.item.model.answer'),
        open: true,
      },
      {
        question: translate('tutorialPage.faq.item.sop.question'),
        answer: translate('tutorialPage.faq.item.sop.answer'),
      },
      {
        question: translate('tutorialPage.faq.item.tool.question'),
        answer: translate('tutorialPage.faq.item.tool.answer'),
      },
      {
        question: translate('tutorialPage.faq.item.knowledge.question'),
        answer: translate('tutorialPage.faq.item.knowledge.answer'),
      },
    ],
  };
}

/** 返回教程页的静态语义文案，确保整页产品 copy 随 locale 切换。 */
function useTutorialCopy(): TutorialCopy {
  const { t } = useAppIntl();
  return buildTutorialCopy(t);
}

/** 渲染教程页主体，展示 FirmDeck 运行时、治理和配置路径的静态说明。 */
export default function TutorialPage() {
  const copy = useTutorialCopy();

  useEffect(() => {
    const rawHash = window.location.hash.slice(1);
    if (!rawHash) return undefined;
    let targetId = rawHash;
    try {
      targetId = decodeURIComponent(rawHash);
    } catch {
      targetId = rawHash;
    }

    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId);
      if (!target) return;
      const top = target.getBoundingClientRect().top + window.scrollY - 24;
      const previousScrollBehavior = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo(0, Math.max(top, 0));
      document.documentElement.style.scrollBehavior = previousScrollBehavior;
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <main className="tutorial-doc-page">
      <section className="tutorial-doc-hero" id="intro">
        <div className="tutorial-doc-hero-copy">
          <span className="ui-typography tutorial-doc-eyebrow">{copy.docEyebrow}</span>
          <h1 className="ui-typography">{copy.heroTitle}</h1>
          <p className="ui-typography">{copy.heroBody}</p>
          <div className="tutorial-doc-actions">
            <a className="tutorial-doc-primary-action" href="#quickstart">{copy.primaryAction}</a>
            <a className="tutorial-doc-secondary-action" href="#core-features">{copy.secondaryAction}</a>
          </div>
          <div className="tutorial-doc-proof-row">
            <span><strong>8</strong>{copy.proofRow[0]}</span>
            <span><strong>6</strong>{copy.proofRow[1]}</span>
            <span><strong>4</strong>{copy.proofRow[2]}</span>
          </div>
        </div>
        <div className="tutorial-doc-hero-map" aria-label={copy.runtimeMapAria}>
          <span className="tutorial-doc-map-label">{copy.runtimeMapLabel}</span>
          <div className="tutorial-doc-map-grid">
            {copy.features.slice(0, 6).map((feature) => (
              <span key={feature.title}>
                <FirmdeckIcon name={feature.icon} />
                <em>{feature.title}</em>
              </span>
            ))}
          </div>
          <div className="tutorial-doc-map-line">
            <strong>{copy.runtimeMapStages[0]}</strong>
            <i />
            <strong>{copy.runtimeMapStages[1]}</strong>
            <i />
            <strong>{copy.runtimeMapStages[2]}</strong>
          </div>
        </div>
      </section>

      <div className="tutorial-doc-shell">
        <aside className="tutorial-doc-nav" aria-label={copy.navAria}>
          <div className="tutorial-doc-nav-title">
            <span>{copy.navTitle}</span>
            <strong>{copy.navSubtitle}</strong>
          </div>
          {copy.tocGroups.map((group) => (
            <nav key={group.title}>
              <span>{group.title}</span>
              {group.items.map((item) => (
                <a key={item.id} href={`#${item.id}`}>{item.label}</a>
              ))}
            </nav>
          ))}
        </aside>

        <div className="tutorial-doc-main">
          <section className="tutorial-doc-section tutorial-doc-intro-panel">
            <div>
              <span className="ui-typography tutorial-doc-eyebrow">{copy.introEyebrow}</span>
              <h2 className="ui-typography">{copy.introTitle}</h2>
              <p className="ui-typography">{copy.introBody}</p>
            </div>
            <div className="tutorial-doc-pain-grid">
              {copy.painPoints.map((item) => <span key={item}>{item}</span>)}
            </div>
          </section>

          <section className="tutorial-doc-section" id="install">
            <SectionHeading eyebrow={copy.installEyebrow} title={copy.installTitle} body={copy.installBody} />
            <div className="tutorial-doc-install-grid">
              {copy.installCards.map((card) => (
                <div key={card.command} className="tutorial-doc-command-card">
                  <span>{card.title}</span>
                  <code>{card.command}</code>
                  <p>{card.body}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="tutorial-doc-section" id="quickstart">
            <SectionHeading eyebrow={copy.quickStartEyebrow} title={copy.quickStartTitle} body={copy.quickStartBody} />
            <div className="tutorial-doc-steps">
              {copy.quickSteps.map((step, index) => (
                <article key={step.title} className="tutorial-doc-step">
                  <em>{String(index + 1).padStart(2, '0')}</em>
                  <div>
                    <h3 className="ui-typography">{step.title}</h3>
                    <p className="ui-typography">{step.body}</p>
                  </div>
                  <strong>{step.outcome}</strong>
                </article>
              ))}
            </div>
          </section>

          <section className="tutorial-doc-section" id="core-features">
            <SectionHeading eyebrow={copy.featuresEyebrow} title={copy.featuresTitle} body={copy.featuresBody} />
            <div className="tutorial-doc-feature-grid">
              {copy.features.map((feature) => (
                <article key={feature.title} className="tutorial-doc-feature">
                  <span><FirmdeckIcon name={feature.icon} /></span>
                  <em>{feature.subtitle}</em>
                  <strong>{feature.title}</strong>
                  <p>{feature.body}</p>
                  <small>{feature.proof}</small>
                </article>
              ))}
            </div>
          </section>

          <section className="tutorial-doc-section tutorial-doc-runtime" id="runtime">
            <SectionHeading eyebrow={copy.runtimeEyebrow} title={copy.runtimeTitle} body={copy.runtimeBody} />
            <div className="tutorial-doc-loop">
              {copy.runtimeSteps.map((item) => <span key={item}>{item}</span>)}
            </div>
          </section>

          <section className="tutorial-doc-section" id="governance">
            <SectionHeading eyebrow={copy.governanceEyebrow} title={copy.governanceTitle} body={copy.governanceBody} />
            <div className="tutorial-doc-governance-grid">
              {copy.governanceItems.map((item) => (
                <span key={item}><FirmdeckIcon name="check" />{item}</span>
              ))}
            </div>
          </section>

          <section className="tutorial-doc-section" id="architecture">
            <SectionHeading eyebrow={copy.architectureEyebrow} title={copy.architectureTitle} body={copy.architectureBody} />
            <div className="tutorial-doc-architecture">
              {copy.architectureLayers.map(([title, body]) => (
                <article key={title}>
                  <strong>{title}</strong>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="tutorial-doc-section" id="flow">
            <SectionHeading eyebrow={copy.flowEyebrow} title={copy.flowTitle} body={copy.flowBody} />
            <pre className="tutorial-doc-code">{copy.flowCode}</pre>
          </section>

          <section className="tutorial-doc-section" id="reference">
            <SectionHeading eyebrow={copy.referenceEyebrow} title={copy.referenceTitle} body={copy.referenceBody} />
            <div className="tutorial-doc-reference-grid">
              {copy.referenceItems.map((item) => <span key={item}>{item}</span>)}
            </div>
          </section>

          <section className="tutorial-doc-section" id="development">
            <SectionHeading eyebrow={copy.developmentEyebrow} title={copy.developmentTitle} body={copy.developmentBody} />
            <div className="tutorial-doc-dev-grid">
              {copy.developmentItems.map((item) => (
                <div key={item.command}>
                  <code>{item.command}</code>
                  <span>{item.body}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="tutorial-doc-section" id="showcase">
            <SectionHeading eyebrow={copy.showcaseEyebrow} title={copy.showcaseTitle} body={copy.showcaseBody} />
            <div className="tutorial-doc-showcase-grid">
              {copy.scenarios.map((scenario) => (
                <article key={scenario.title}>
                  <h3 className="ui-typography">{scenario.title}</h3>
                  <p className="ui-typography">{scenario.body}</p>
                  <code>{scenario.stack}</code>
                  <div>
                    {scenario.tags.map((tag) => <span key={tag} className="ui-tag">{tag}</span>)}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="tutorial-doc-section" id="faq">
            <SectionHeading eyebrow={copy.faqEyebrow} title={copy.faqTitle} body={copy.faqBody} />
            <div className="tutorial-doc-faq">
              {copy.faqItems.map((item) => (
                <details key={item.question} open={item.open}>
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

/** 渲染统一的章节标题块，保持教程页各区块结构一致。 */
function SectionHeading({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <div className="tutorial-doc-section-heading">
      <span className="ui-typography tutorial-doc-eyebrow">{eyebrow}</span>
      <h2 className="ui-typography">{title}</h2>
      <p className="ui-typography">{body}</p>
    </div>
  );
}
