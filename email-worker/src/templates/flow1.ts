/**
 * Flow 1 — non-enrolled students and leads. Eight emails, Days 1–21.
 *
 * Copy from "Competition AI email flows". Purpose per the document: introduce
 * competitions as external validation rather than résumé decoration, establish
 * expertise, then earn the consultation.
 *
 * Nothing here merges competition names. The public flow must not leak the
 * repository, so the specifics live in the emailed report, not the drip.
 */

import { bookCall, h, ol, p, quote, ul, type EmailTemplate } from './blocks.js';

/** Step 1 · Day 1 */
const whyCompetitionsMatter: EmailTemplate = {
  subject: 'Can competitions actually strengthen a university application?',
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p(
      'A single competition or an award never guarantees admission to a top university. But the right competition can do something valuable.',
    ),
    p('It can serve as an external benchmark to validate the quality of a student’s work.'),
    p('Instead of simply saying:'),
    quote('I’m interested in engineering.'),
    p('A student may be able to demonstrate:'),
    quote(
      'I identified a problem, built a solution, tested it, improved it, and that work was recognised by academics and professionals in the industry.',
    ),
    p('That distinction matters.'),
    p('Strong competition participation can demonstrate:'),
    ul([
      'Intellectual curiosity beyond school',
      'Technical or research depth',
      'Initiative and persistence',
      'Independent problem-solving',
    ]),
    p(
      'We’ve taken student projects across AI, engineering, biology, sustainability, economics, design and social impact into national and international competitions — and the strongest outcomes usually begin long before the application itself.',
    ),
    p(
      'If {{Student Name}} already has an idea or project, we can help assess where it could compete. And if they don’t have one yet, we can help identify what they could build or research to take it further. We’d be happy to have an initial conversation.',
    ),
    bookCall(),
  ],
};

/** Step 2 · Day 3 */
const whatActuallyWins: EmailTemplate = {
  subject: 'What kinds of projects actually win major competitions?',
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p(
      'One thing we have learned from guiding students across multiple competition applications is that a clever idea is rarely enough on its own. The projects that tend to stand out usually combine several things: a strong specific problem, a key affected demographic, a pointed clever application of technology, and a differentiated solution.',
    ),
    p(
      'Competitions barely award marginal improvement of an existing solution or simply reproducing something that already exists.',
    ),
    p('At CreatED, our program encourages —'),
    ol([
      'Testing, experimentation, user feedback, data collection and validation to record Evidence.',
      'Multiple rounds of iteration to demonstrate the student’s learning journey and record Project Growth and Improvement.',
      'Enough technical, scientific or analytical substance to withstand questions from judges and show Depth.',
      'Practising the ability to explain why the project matters and why this approach works to help the intended audience, ensuring good Communication.',
    ]),
    h('Angad Tathgir | University of Pennsylvania'),
    p(
      'Starting point: Angad volunteered with a nonprofit that collected and recycled e-waste.',
    ),
    p('What he did: Built a zero-emission refrigerator using discarded MRI magnets.'),
    p('Outcome: IRIS Top 100, IEEE publication, Diana Award, BeVisioneers Fellowship.'),
    p(
      'Competitions are usually won well before the final pitch — through the quality of the work behind it. Already have a project that you want to test against competition standards? Or want help building one that could eventually become competitive?',
    ),
    bookCall(),
  ],
};

/** Step 3 · Day 6 */
const trackRecord: EmailTemplate = {
  subject: 'Where CreatED student projects have gone',
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p('The interesting thing about competitions is how different winning projects can look.'),
    p('A few examples from students we’ve worked with:'),
    h('Samaya Vaidya | Yale'),
    p('Starting point: Samaya experienced fatigue and low energy due to Thalassemia.'),
    p(
      'Project: Built a bioinformatics pipeline to identify an iron supplement formulation as an opportunity for new treatments for Thalassemia.',
    ),
    p('Outcome: IJHSR publication, S.T. Yau.'),
    h('Samaira Mohunta | Brown'),
    p('Starting point: Samaira saw students at government schools struggling without desks.'),
    p(
      'Project: Built a school bag that converts into a functional desk for government schools with poor infrastructure.',
    ),
    p('Outcome: CREST Gold Award.'),
    h('Jiana Shroff | Dartmouth'),
    p('Starting point: A national-level sailor wanted to optimise sailboat performance.'),
    p('Project: Conducted research on optimising sailboat design and performance.'),
    p('Outcome: S.T. Yau Top 10; only Indian female finalist who got invited to Hong Kong.'),
    h('Vivaan Vasudeva | Berkeley'),
    p(
      'Starting point: Vivaan explored how India’s indigenous Sattu could make high-quality protein more accessible.',
    ),
    p(
      'Project: Developed SattuFusion, a pediatric-safe vegan and gluten-free protein powder made from Sattu.',
    ),
    p(
      'Outcome: 1st Place, Asia Category at Blue Ocean Entrepreneurship Competition; Top 10 globally among 13,000+ applications from 160 countries; UNESCO Multimedia Competition Honourable Mention.',
    ),
    p(
      'These may come from completely different fields, but the pattern is usually similar: strong idea + serious execution + evidence + refinement → the right competition.',
    ),
    p(
      'The goal is not to force every student into the same competition. It is to understand what kind of work they are capable of producing, and where that work has the strongest chance of standing out.',
    ),
    p(
      'If {{Student Name}} already has something they are building, we’d be happy to take a look. If they don’t, we can also help them identify a strong direction based on their strengths and skills from scratch.',
    ),
    bookCall(),
  ],
};

/** Step 4 · Day 9 */
const reachTargetSafety: EmailTemplate = {
  subject: 'Why students shouldn’t apply to just one competition',
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p(
      'One mistake students often make is choosing one prestigious competition and putting everything into that application. A stronger approach is to maximise your chances and build opportunities.',
    ),
    p('At CreatED we think about competitions in three categories:'),
    ul([
      'REACH: Highly prestigious, highly selective competitions where even very strong work may not advance.',
      'TARGET: Competitions where the project has a strong fit with the judging criteria and expected level of work.',
      'SAFETY: More accessible opportunities where a well-developed project has a comparatively stronger chance of recognition.',
    ]),
    p(
      'The same project could potentially be positioned across all three but the applications, evidence and time involvement may differ. This is why competition selection is crucial and how CreatED can help you map out Reach–Target–Safety options for your project.',
    ),
    p(
      'If they are still yet to start, we can help them build towards those opportunities intentionally. Developing an understanding of a project is very important to help guide competition selection.',
    ),
    bookCall(),
  ],
};

/** Step 5 · Day 12 */
const justAnIdea: EmailTemplate = {
  subject: 'Do you need a finished project to enter a competition?',
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p('Different competitions expect very different levels of development.'),
    p('Some will consider an idea or concept, while others expect:'),
    ol(['A researched solution', 'A prototype', 'A research paper']),
    p('A student who only has an early idea may still have options. But the important question is:'),
    quote('Which competitions match the stage they are actually at?'),
    p('Applying too early can waste a strong opportunity.'),
    p('Waiting too long can mean missing the right cycle entirely.'),
    p(
      'If {{Student Name}} has an idea, unfinished project or completed project, we can help assess what level it is currently at and where it could realistically go on our first call.',
    ),
    p('If you don’t yet have a project, we can help them identify and build one.'),
    bookCall(),
  ],
};

/** Step 6 · Day 15 */
const oneProjectMany: EmailTemplate = {
  subject: 'One strong project can last an entire competition year',
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p('Students sometimes assume that they need a new project for every competition.'),
    p('Usually, the opposite is more powerful.'),
    p('A genuinely strong project can continue evolving across an entire year. The process could look like:'),
    ol([
      'Stage 1: Build the first version.',
      'Stage 2: Enter a competition.',
      'Stage 3: Use feedback to improve testing, evidence or design.',
      'Stage 4: Enter Competition 2 with a stronger submission.',
      'Stage 5: Develop the project further and target Competition 3.',
    ]),
    p(
      'With each round of application and feedback, the project becomes progressively more refined. And the student builds a coherent body of work instead of accumulating disconnected activities.',
    ),
    p('That depth is often far more interesting than simply entering as many competitions as possible.'),
    p(
      'If {{Student Name}} already has a project, we can help map out a longer-term competition strategy around it. If they don’t, we can help them build a project capable of supporting one.',
    ),
    bookCall(),
  ],
};

/** Step 7 · Day 18 */
const whatCouldThisBecome: EmailTemplate = {
  subject: 'What could {{Student Name}} take into competitions?',
  requires: ['Student Name'],
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p('By this point, you may be wondering: what could {{Student Name}} actually enter?'),
    p('The answer lies beyond their favourite subject and interests. We would want to understand:'),
    ul([
      'What they are genuinely interested in',
      'Whether they already have an idea or project',
      'Their current technical or academic skills',
      'How much time they have',
      'Whether they prefer research, building, design, entrepreneurship or another direction',
      'What level of competition they want to target',
    ]),
    p('From there, we can determine whether the right next step is:'),
    ul([
      'Take an existing project into competitions, or',
      'Build something new with competition potential from the outset',
    ]),
    p(
      'That is exactly what we can explore in the first consultation. To understand what strategy would work best for you, connect on a call with us.',
    ),
    bookCall(),
  ],
};

/** Step 8 · Day 21 */
const finalConversion: EmailTemplate = {
  subject: 'Ready to build a competition strategy?',
  requires: ['Student Name'],
  blocks: [
    p('Hi {{Student/Parent Name}},'),
    p(
      'Over the past few weeks, we’ve shared how strong competition projects are built, how winning students think strategically about competition selection, and how one project can develop over multiple rounds of applications.',
    ),
    p('To simplify it, let’s look at two possible pathways for {{Student Name}} —'),
    p('If they already have a project, we can assess:'),
    ul([
      'Where it fits',
      'What level it is currently at',
      'Which competitions are realistic',
      'What needs to improve before submission',
    ]),
    p(
      'If they don’t have one yet, we can help identify a project direction with the potential to qualify for national or international competitions.',
    ),
    p(
      'Either way, the starting point is a conversation. To start one, book a call with our team of experts.',
    ),
    bookCall(),
  ],
};

export const FLOW1: Record<number, EmailTemplate> = {
  1: whyCompetitionsMatter,
  2: whatActuallyWins,
  3: trackRecord,
  4: reachTargetSafety,
  5: justAnIdea,
  6: oneProjectMany,
  7: whatCouldThisBecome,
  8: finalConversion,
};
