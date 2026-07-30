export const coverAssets = [
  "/assets/lesson-spring-bird.png",
  "/assets/lesson-geometry.png",
  "/assets/lesson-landscape.png",
];

export const initialNotebooks = [
  {
    id: "chinese",
    title: "语文备课本",
    className: "七年级（1）班",
    year: "2025—2026 学年",
    subject: "语文",
    tone: "teal",
    updatedAt: 6,
    files: [
      { id: "c1", title: "春日的第一声鸟鸣", type: "阅读课", pages: 18, updated: "今天 10:30", image: coverAssets[0] },
      { id: "c2", title: "文章的结构与留白", type: "写作课", pages: 24, updated: "昨天 16:20", image: coverAssets[1] },
      { id: "c3", title: "山水之间的观看方式", type: "拓展课", pages: 16, updated: "07月08日", image: coverAssets[2] },
    ],
  },
  {
    id: "math",
    title: "数学备课本",
    className: "八年级（2）班",
    year: "2025—2026 学年",
    subject: "数学",
    tone: "sage",
    updatedAt: 5,
    files: [
      { id: "m1", title: "轴对称与几何之美", type: "概念课", pages: 20, updated: "昨天 09:15", image: coverAssets[1] },
      { id: "m2", title: "从图形到证明", type: "习题课", pages: 28, updated: "07月09日", image: coverAssets[2] },
    ],
  },
  {
    id: "english",
    title: "英语备课本",
    className: "八年级（1）班",
    year: "2025—2026 学年",
    subject: "英语",
    tone: "coral",
    updatedAt: 4,
    files: [
      { id: "e1", title: "A Letter From Spring", type: "Reading", pages: 22, updated: "07月07日", image: coverAssets[0] },
      { id: "e2", title: "Places and Memory", type: "Speaking", pages: 17, updated: "07月04日", image: coverAssets[2] },
    ],
  },
  {
    id: "physics",
    title: "物理备课本",
    className: "九年级（3）班",
    year: "2025—2026 学年",
    subject: "物理",
    tone: "amber",
    updatedAt: 3,
    files: [
      { id: "p1", title: "光的反射", type: "实验课", pages: 20, updated: "07月02日", image: coverAssets[1] },
      { id: "p2", title: "看见声音", type: "探究课", pages: 14, updated: "06月28日", image: coverAssets[0] },
    ],
  },
  {
    id: "history",
    title: "历史备课本",
    className: "七年级（3）班",
    year: "2025—2026 学年",
    subject: "历史",
    tone: "sage",
    updatedAt: 2,
    files: [
      { id: "h1", title: "长安的一天", type: "主题课", pages: 26, updated: "06月24日", image: coverAssets[2] },
    ],
  },
  {
    id: "biology",
    title: "生物备课本",
    className: "八年级（4）班",
    year: "2025—2026 学年",
    subject: "生物",
    tone: "coral",
    updatedAt: 1,
    files: [
      { id: "b1", title: "一片叶的呼吸", type: "观察课", pages: 19, updated: "06月18日", image: coverAssets[0] },
    ],
  },
];
