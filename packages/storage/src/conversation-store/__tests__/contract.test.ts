import {
  describeChannelLimits,
  describeChannelLog,
} from '@sheavly/testing/store/channel-contract.fake';
import { describeConversationStore } from '@sheavly/testing/store/store-contract.fake';
import { useTempFolder } from '../../testing/temp-folder.fake.js';
import { FileConversationStore } from '../conversation-store.service.js';

const temp = useTempFolder('file-conversations-');

describeConversationStore({
  name: 'FileConversationStore',
  make: () => new FileConversationStore({ folder: temp.path(), onProblem: () => undefined }),
});

describeChannelLog({
  name: 'FileConversationStore',
  make: () => new FileConversationStore({ folder: temp.path(), onProblem: () => undefined }),
});

describeChannelLimits({
  name: 'FileConversationStore',
  make: (limits) =>
    new FileConversationStore({ folder: temp.path(), onProblem: () => undefined, limits }),
});
