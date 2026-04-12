from crewai import Agent, Task, Crew, Process
from langchain.llms import Ollama

# Configuration for Local Gemma via Ollama
gemma = Ollama(model="gemma:7b")

def create_octosync_crew(sandbox_path: str):
    """
    Sets up the 6-agent pipeline for OctoSync AI.
    """
    
    # 1. The Scout
    scout = Agent(
        role='The Scout',
        goal=f'Scan the codebase in {sandbox_path} and identify bugs or logic flaws.',
        backstory='You are an expert bug hunter. You look for edge cases, syntax errors, and logical inconsistencies.',
        llm=gemma,
        verbose=True
    )

    # 2. The Brainstormer
    brainstormer = Agent(
        role='The Brainstormer',
        goal='Analyze the Scout\'s report and draft potential architectural fixes.',
        backstory='You are a senior software architect. You think about the big picture and how to solve problems elegantly.',
        llm=gemma,
        verbose=True
    )

    # 3. The Coder
    coder = Agent(
        role='The Coder',
        goal='Write the actual code to fix the issues identified.',
        backstory='You are a world-class Python developer. You write clean, efficient, and PEP8 compliant code.',
        llm=gemma,
        verbose=True
    )

    # 4. The Reviewer
    reviewer = Agent(
        role='The Reviewer',
        goal='Inspect the Coder\'s work and either approve or reject with feedback.',
        backstory='You are a meticulous code reviewer. You ensure quality, security, and performance.',
        llm=gemma,
        verbose=True
    )

    # 5. The Auditor
    auditor = Agent(
        role='The Auditor',
        goal='Perform a final deep-dive review and generate a user-friendly summary report.',
        backstory='You are a quality assurance lead. You summarize the technical changes into a clear status update for the user.',
        llm=gemma,
        verbose=True
    )

    # 6. Security Specialist
    security = Agent(
        role='The Security Specialist',
        goal='Verify that all changes comply with the sandbox security protocols.',
        backstory='You are a cybersecurity expert. Your job is to ensure that no code can escape the sandbox or cause system damage.',
        llm=gemma,
        verbose=True
    )

    # Define Tasks (Sequential)
    task1 = Task(description='Scan the directory and list all identified issues.', agent=scout)
    task2 = Task(description='Propose solutions for the issues found by the Scout.', agent=brainstormer)
    task3 = Task(description='Implement the proposed solutions in the code.', agent=coder)
    task4 = Task(description='Review the implementation and ensure it solves the problems.', agent=reviewer)
    task5 = Task(description='Generate a final summary of all fixes and current system status.', agent=auditor)
    task6 = Task(description='Perform a final security audit on the summary and changes.', agent=security)

    # Create Crew
    crew = Crew(
        agents=[scout, brainstormer, coder, reviewer, auditor, security],
        tasks=[task1, task2, task3, task4, task5, task6],
        process=Process.sequential
    )

    return crew

# Example usage:
# crew = create_octosync_crew("D://Spe/Snake")
# result = crew.kickoff()
# print(result)
