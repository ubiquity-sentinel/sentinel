import type { GitSha } from "../src/contracts/brands.ts";
import { resolveFailoverModelId } from "../src/host/model-route.ts";

/** Exact authenticated legacy wave identities; no runtime-selected history. */
/**
 * The documented runtime routes a retained producer could have used: the
 * gateway primary and its per-run DeepSeek fallback. Historical recovery
 * accepts a receipt from either and refuses anything else.
 */
export const HISTORICAL_RECOVERY_PROVIDERS: readonly string[] = [
  "uos",
  "deepseek",
];

/**
 * The HTTP 429 failover model id every hosted producer route carried, which a
 * recovered receipt may name instead of its planned primary model.
 *
 * Trusted without any runtime input: the hosted runtime resolves its route
 * with `resolveModelRoute` over a fixed named mapping (`actions-repair-host`)
 * that never includes `SENTINEL_MODEL_FAILOVER_ID`, and no supervisor job
 * grants or forwards that variable, so every hosted route's `failoverModel`
 * is this same pure resolver's result for an absent override (the default).
 * The launcher evaluates that resolver from its own source; it never reads
 * the id from an artifact, a receipt or the maintenance environment (which
 * carries no model route at all). A test pins the no-override invariant.
 */
export const RECOVERY_ROUTE_FAILOVER_MODEL: string = resolveFailoverModelId(
  {},
);

export const HISTORICAL_C63 = {
  executionId: "37354374590:1:repair",
  runtimeSha: "e4cef46332cf124a8c283d798a963cf5f66e45c2" as GitSha,
  generation: 63,
  run: {
    runId: 37354374590,
    runAttempt: 1,
    launcherSha: "b261c3672b29c29cfe6858fe96beb05687018c8f" as GitSha,
  },
  base: "3691fe4a36e4e4c6aae6f8c6aa04c12ed3ff6698",
  repository: {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: 155687488,
  },
  rows: [
    {
      id: "issue-ubiquity-ai.ubq.fi-576",
      issue: 576,
      reservation:
        "ffc3337e27e0e05a641908db08825ad63bc6d6868cfabcd5af667b2ede4d4677",
      cellId:
        "65dae22ecd6455374aa5d3a1873c52e0cd07f2a7b4abdb57a40b39e025a42b86",
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-616",
      issue: 616,
      reservation:
        "7d9d1b7949b3d5dc3c9917cf24263324f23674ce891f9f269b73a9e787d8bad4",
      cellId:
        "f2a5c534305b6229e3214cf10f64f54c6d9fff81004c8a1a190f87528c2b124f",
    },
    {
      id: "issue-ubiquity-ai.ubq.fi-618",
      issue: 618,
      reservation:
        "2956b4efb0ba8181e3e0c15f6ce7bd024640706c293cdb34a7dfd322e3d4ae86",
      cellId:
        "389abc16ad5eda81f11b4eca7407b43912b8d43398edb516d830ff4212fa5cb4",
    },
  ],
} as const;

export const HOSTED_HISTORICAL_RELEASE_WITNESSES = [
  {
    commit: "fd976f84ba57e4090021a2f06aa9c8ff4acb3a06" as GitSha,
    executionId: HISTORICAL_C63.executionId,
    logDigest:
      "efe0cf9e6434798bdc6e0ba9ee693f2c4839e95bfffafd1de307478cb2fb72b0",
    reservationIds: [
      ...HISTORICAL_C63.rows.map((row) => row.reservation),
      "8da7cfad2230c22de6955d53a2b6923ce1734dd825a2440c43d6a74440c99a09",
      "3cb86e0f76b76aadaaac176c172e43effb5c8533c7d1b3ca1339f548da534af5",
      "fb79ebbb9552de0df004fdf8d19ec2bd2be7dc8ac36b94efb98dddce72d0804e",
      "1bc96d7012496ae85316abdd6e68914fa9944288c71a5fade3f8005533d08ebc",
      "d53181817d837b13f62ab7ee92fd7e540d576312c90239cebc4c0d7268a4e0d0",
      "487ed315f82ff0bd132fbe8fa97b6fd736f1fdc2701497367cb981f8ced0161d",
      "128b0db9b4f8c157f953b9ecfb18544ee04f019fb78eeec7ddf7e649a031d522",
      "8f4f55cb4af1c3e543e36556da8890c1a9c11b913415d4cfb0c3e35c5118241a",
      "63988226e9739da266ce14de1cce5746d662220e39a8ddcb99337ab40b405d69",
      "0d8da09d774019c738f09dfdd6a249993a7bd49ffeb03b21b4629132e739cd44",
      "53437275fa4adaa9788d2ca51b971cc0a3744611c5cf281d84b95c4d8d73fed7",
      "73535d9286a092a3f7b2d96c22a8ef6a0f935b975d09006cd7e418fc867d91cd",
      "c97ba108b7c9e9aaa01bc0ac765ed962292f20514b66ec99913320d42e26eb2d",
      "99255d8f4e420dc7947a6bc5fc6acfb47d33e2acbb9b4234264bf2ac735d3437",
      "6ca9fd2eb1ad7e38d7c5676fd15e1f80dfa0fa3339064a7711e60d53a9bd5fcc",
      "097cf4dcf51d6b671e0014bda5db042fe0f61b7823d978fa71bddf7560c9baae",
    ],
  },
  {
    commit: "d3e5fe3afcdb22e91e5adbc8c9c842a2fb3b632b" as GitSha,
    "executionId": "37136320870:1:repair",
    "logDigest":
      "42a15377b48d6c450a48ec576601b2c309952bba6d14b4fb5e66bdcfaf16a382",
    "reservationIds": [
      "a5a5a4eb8def3fb0dd206be5ef2e75bdcc2650c32ed69fd82949e86864ef3dc3",
      "2728ed37da51affad5ac17c398e225e75d3cee1072cc4a767843940a37ceb67e",
      "f99343ab71054a98b8c4a9c29f9f2b19a67437147d52d7b6c366f9e145b84a17",
      "0df2dcacd998b4d6fbf3feb09ac84bab9364455286eafcab5b1b7f856add56f7",
      "448359fb26b85d331c68ea900a670be80bcd8545efab306d69530e3a440ea402",
      "7b91eca5b9a29cc65f1e212194c9b56a8e224165f42e3e6a5f7db629e89632c3",
      "d5cbbdd18a86599ac27d2f7fe17a0bd9d926b40571205a70baee3caa6bf1882e",
      "99b14f1d04d90b2406f686d11d76379cc1387766047f8bef75c1a03b36c53741",
      "40376755c0596ef299de3727841b4b1f09d48584ea7983ee28906d8ce773c1f8",
      "18c28151264422816eac473c9ba9d24146c44d73a2b35f8b399f71dc0e7a9813",
      "56c6f2b4f30243601743e10a168e64b94f2ef41b5594220a9fbe03e3d900f32a",
      "a384e381e286775a57948c62afe39b7bc2377194260b3f5256b3de8929c2345d",
      "df86a3969fcda87556c790a1657859a16518e8e60e5ab56970d6dfd3b299e418",
      "8be524c6a84d2437e409cbf1d20f41d0f2494bda32a1134010e712df7afdf22d",
      "39b9a47b246bc52d0b15eee5ffcae5f33adb1d59a4b4d22822b3f801703a1217",
      "0e5ef4a90f4a3e96c989640652cd115087d1d5b786bcf44d6f356416c145076c",
      "421ad1ffb88498aa18bc2d8bc23bded5040872000e0777f8da9a7981c4e8fc84",
    ],
  },
  {
    commit: "6f7d7807b3735d97641704d6afa5c4e659e849da" as GitSha,
    "executionId": "37156933037:1:repair",
    "logDigest":
      "9e2cd0411cf981d23d9aca67e41f10a8d7bce559c1c0280f58631450f3a16136",
    "reservationIds": [
      "05914e39fc4b2d04752f67041dfcef3b22353aecab648e9ab84b576641dcc951",
      "c574901f8e8976026d9313e620612dceb6a331b425443d3f7182f45b834e8d3b",
      "b70df1a941fbf9f21192b0925fe3d1a8b21670ece85360f3e8ebad4d4107a213",
      "39cc9b44691f9664ad7ca565ab4977b19e76435964dbbe2a5a2a59a618f8c2ca",
      "b7e2233c8ba405373805dadef6403ec8d24a0da5b6442153d33d427b5763930d",
      "b7275d76529d103fe7da3e7a2fcb3b8e6e444c3b2107e1f4b1d8a0ccd65babc1",
      "6a86c8363fefd915b575ce2a21b737c0cf4dd48651d1e3e5a38ad9c2495bc63c",
      "3903063fbf3b049a16ab323283932d3758f624595193633de6dd2528560b2bc4",
      "be97f92573f794189512e8cffef4e6fb1277abb9d32da8dd3ddada5c4d3f84ec",
      "0ca007a49aa57177fe054e16a8c76b6f9d20919feb0edde79638eeb63b0339a1",
      "4977b245da20cd0741801efeb29ab1ce399797e55dbf5e896eb1dc3097e3dd7c",
      "d36b9d8e05ce00f3d696daba691b442ba84df3db7294bc9138e79e690235c956",
      "3c8d01b2842eb6c085351099835c120f47dd533d1e96841e59986f038cf6b215",
      "f55ec1fc902224ab8e70f085778620525febdae37f3fd334e2a2c41ff30589f1",
      "6d2d0f1b6f462bb134774a46c1642529cc350477f3f8146cba135070399e21a2",
      "fb5dc155319f94be9d273044c1b3bf1be031b18fc73211803b20811919c815fc",
      "1333409255344a59b15eff709136f80f0c78a63a5695b7c60a7b2d2323854558",
      "fb6ffebb981f6f2b815adc0644b867db67886ab1d103542c61391321a75d95e2",
      "feec7f11741630755a8df4640f80ed1999bd43d4bd01425ede1d44a32cfb3e9e",
      "9ace0199e2d63e597a400357b74a40d12123dbe5837aa57be5885ae276c68b86",
      "1e59655194095dc16a9193105b57c1e7c68528f286f6f8e79f6e537fb729551a",
      "5c1b2a234ec5bd050b17bc7a6cb525ed0dc2534e25bc6b7d01a3952e53fd0f36",
      "8aa6c1cf368a45c0f0e9f3eab962109a8cc9bb8f002d912adb0c19b85e323549",
      "b693cb12d961d68bc90e2f0bd36aec9a1822b50135fc69df4c0ce04858445290",
      "d2d7ae3b0540e7348c75a70ee1d4b9eb058df17690a3752e3b5eb5bf078d263b",
    ],
  },
  {
    commit: "1a706850cf981273a98521c4b1222a765b9c90ed" as GitSha,
    "executionId": "37160285420:1:repair",
    "logDigest":
      "3a03c95cbc4a10faa78f90cc61444911bddd7ef2f35eb4dadd1daff85ef3cb5a",
    "reservationIds": [
      "537ab0051c0d8b1b20002cc45e40b198a96cde83bff3ad1dbe8fa918be06197f",
      "9bd37b5aa6fe58fc8348699ef437cc08f2b73c115488dcfbb217460dbd4d606b",
      "83bd09f94fe5895264eb91e972b754e287503c637f3d1a1d0a0c7e1fe6daf793",
      "b9b116ae25fcf76903209a6bcfc40237c092406d9948448398195b8dacf0052b",
      "f2f5ace0a637da758688b40c25b953caa57db5db0aa9bdabf339a1953280f08c",
      "d3e308bab83964b714ad94ae4ea4b361b2d0fcd406ebeba71cb87c0182bbe787",
      "c89f4a3377ef1c8b2062a0a98599fe9d5f23a44f0b31dcf8367a4d1a0fe74061",
      "5b3f11483b67d4c3ff407f14ae43ba1c0e1071e32a7beea9db34acbb02828a91",
      "a2aae7ba3e7e121598ba70fe8a8a5b30f1598efc887b590e6ed9be582a889088",
      "1ac673010b05e5217222c0e57adeccad1db6f75bf60b2d1bc81f240043fa6263",
      "43be66f33a484a7d0653cd151fb9f5a3a620cbaad6182fa06a319999306c1c2f",
      "74bb67bf09a54e1544ba910379a5ac4a31e1faa99a322585209ab0b240e1fff6",
      "95027b082bcd340e05422cabcb81632908e7a40bb20c51667525716005bea252",
    ],
  },
] as const;
