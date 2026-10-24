// Typed navigation (H2-6.8): every screen's params, checked by TypeScript.
import type { NavigatorScreenParams } from '@react-navigation/native';

export type SearchStackParamList = {
  SearchMain: undefined;
  IndividualProfile: { individualId: string };
};

export type RootTabParamList = {
  Record: undefined;
  Search: NavigatorScreenParams<SearchStackParamList>;
  VoiceAssistant: undefined;
  Categories: undefined;
  Profile: undefined;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootTabParamList {}
  }
}
