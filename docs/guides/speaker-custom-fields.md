# Give speakers a custom form to fill out

Organizers sometimes need event-specific information that is not part of a
speaker's standard profile, such as dietary needs, A/V requirements, or a
shorter biography. This guide explains how to collect those answers with a
portal form and review them from the speaker's record.

## 1. Build the portal form

Open [Portal forms](/admin/portal-forms) and create a form. The builder has
three steps: **Setup**, **Questions**, and **Settings**.

Selecting **+ Add form** creates a "submissions" form automatically — every
form made this way collects information tied to a speaker's own record.
Contact- and group-targeted forms exist in the data model but have no
organizer screen to create or attach one yet, so this is the only kind
available today. The Portal forms list shows each form's type as a small
label under its name (`submissions · N questions · used by N tasks`).

In **Setup**, give the form an internal name and the title speakers will see.

In **Questions**, add the information you need. Each question can be required,
locked, both, or neither. A required question must be answered; a locked
question is visible to the speaker but cannot be edited by them. Locked fields
are useful when you want to show an organizer-set value without letting the
speaker change it.

In **Settings**, finish the form's delivery settings, then publish the form
when it is ready for speakers. The three-step builder and its publish control
are both on `/admin/portal-forms/<id>`.

## 2. Create a form task

Go to [Speaker tasks](/admin/tasks) and choose **Form** under **Task type**. It
appears alongside **General** and **File request**.

Choose the portal form, enter a task title and any instructions, and set a due
date if needed. Under **Assignment**, choose **Selected speakers** or **All
speakers**. If you choose selected speakers, highlight each person who should
receive the form, then select **Create tasks**. Each chosen speaker gets their
own task; this assignment behavior is visible on `/admin/tasks`.

The picker shows only portal forms belonging to the current event. The event's
public call-for-proposals form is deliberately excluded because CFP forms and
speaker portal forms serve different purposes.

## 3. Decide what should happen for speakers accepted later

To reuse the form during future speaker onboarding, select **Also give this form to speakers accepted later** before creating the task. This saves a
template, so a speaker accepted after today receives the same form
automatically.

The limitation is important: **Auto-provisioned copies carry no due date.** An
absolute date chosen today cannot become the relative timing that a reusable
template needs. After a later speaker receives the task, set that task's
deadline by hand. The checkbox and this exact warning appear together on
`/admin/tasks`.

Speakers see these assignments as **Form to complete** in their task list,
rather than **Mark complete when done**, the label used for a plain task. This
distinction appears on `/portal/tasks`.

## 4. Review a speaker's answers

Open the speaker from the organizer's speaker list, then find the **Custom fields** panel on `/admin/speakers/<id>`. The panel groups the questions and
answers under each assigned form task.

Answers are displayed in a readable form: multiple selections become a
comma-separated list, checkboxes appear as **Yes** or **No**, and uploaded files
show their filename instead of an internal identifier. If a question has no
answer, the panel shows *Not answered yet* in italics instead of leaving an
ambiguous blank.

## Field types and boundaries

The question builder at `/admin/portal-forms/<id>?step=questions` currently
offers these field types:

| Field type | Use it for |
| --- | --- |
| `text`, `textarea` | Short or longer written answers |
| `select`, `multiselect` | One choice or several choices from a list |
| `checkbox` | A yes-or-no answer |
| `email`, `url`, `phone` | Contact details and links |
| `number`, `date` | Numeric values and dates |
| `file` | A document or other requested upload |

Only forms marked for the portal are offered by the form picker on
`/admin/tasks`. Forms used for the public CFP are marked separately and never
appear there, even when they belong to the same event.

The underlying form structure allows contact- and group-scoped forms, but the
current organizer interface exposes only the **Submissions** type. This guide
does not apply to contact or group forms until screens exist to create and
attach them.
